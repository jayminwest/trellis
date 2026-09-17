/**
 * `trellis fleet` — audit every target in a `targets.yaml` through the
 * deterministic core (SPEC §11, §12).
 *
 * Thin per SPEC §13.1: call the core {@link runFleetTargets} service (load +
 * validate the fleet, run each target through the same
 * `runWorkspaceAudit` the single-repo CLI folds, optionally record history),
 * shape the three output variants, then apply the {@link assessFleet}
 * exit-code rollup. Each target's policy assessment comes from its own
 * `trellis.yaml` (or the target's explicit `config`); a missing path or a
 * per-target failure is isolated into an error row without aborting the
 * fleet. Canonical drift rides along as a separate, non-scoring capability —
 * it never gates the exit here.
 *
 * Stateless by default (SPEC §8, §10): no database is opened unless
 * `--history` is passed; `--db` overrides the central DB location.
 *
 * Exit codes (SPEC §9): `0` clean; `2` when any target errored or tripped
 * its declarative policy (the report is still emitted to stdout; the reasons
 * go to stderr); `1` on an operational error. The retired readiness knobs
 * (`--fail-on`, `--min-level`) and investigation knobs (`--no-cache`,
 * `TRELLIS_PI_BIN`) fail fast with actionable migration errors.
 */
import type { Command } from "commander";
import { Option } from "commander";
import { AuditRunError } from "../audit/index.ts";
import {
	assessFleet,
	renderFleetMarkdown,
	renderFleetTerminal,
	runFleetTargets,
	TARGETS_FILE,
	TargetsError,
} from "../fleet/index.ts";
import { LegacyConfigError, legacyConfigMessage, retiredReadinessMessage } from "../legacy.ts";
import { CliError, EXIT, emit, FailOnExit, type Rendered, resolveFormat } from "./output.ts";

/** Local options for the fleet command, merged with the global format flags. */
interface FleetCliOptions {
	json?: boolean;
	md?: boolean;
	targets?: string;
	/** Opt-in persistence (SPEC §10). */
	history?: boolean;
	/** SQLite history path; defaults to `TRELLIS_DB` env or `~/.trellis/trellis.db`. */
	db?: string;
	/** Retired (`--no-cache`): kept as a hidden flag so passing it errors actionably. */
	cache?: boolean;
	/** Retired (`--fail-on`): kept as a hidden flag so passing it errors actionably. */
	failOn?: string;
	/** Retired (`--min-level`): kept as a hidden flag so passing it errors actionably. */
	minLevel?: string;
}

/** Register the `fleet` subcommand on `program`. */
export function registerFleet(program: Command): void {
	program
		.command("fleet")
		.description("audit every target in targets.yaml")
		.option("--targets <file>", "fleet declaration", TARGETS_FILE)
		.option("--history", "record each target's run in the central history (opt-in)")
		.addOption(new Option("--db <path>", "SQLite history path").hideHelp())
		.addOption(new Option("--no-cache", "retired: no investigation pass remains").hideHelp())
		.addOption(new Option("--fail-on <mode>", "retired: policy is declarative now").hideHelp())
		.addOption(new Option("--min-level <n>", "retired: maturity levels are gone").hideHelp())
		.action(function (this: Command) {
			return runFleetCommand(this.optsWithGlobals() as FleetCliOptions);
		});
}

/** Fail fast on retired investigation/readiness knobs with actionable messages (SPEC §14). */
function rejectRetiredKnobs(opts: FleetCliOptions): void {
	if (opts.cache === false) throw new CliError(legacyConfigMessage("--no-cache"));
	if (process.env.TRELLIS_PI_BIN?.trim()) {
		throw new CliError(legacyConfigMessage("TRELLIS_PI_BIN"));
	}
	if (opts.failOn !== undefined) throw new CliError(retiredReadinessMessage("--fail-on"));
	if (opts.minLevel !== undefined) throw new CliError(retiredReadinessMessage("--min-level"));
}

/** Load the fleet, run every target through core, emit, then apply the exit rollup. */
async function runFleetCommand(opts: FleetCliOptions): Promise<void> {
	const format = resolveFormat(opts);
	rejectRetiredKnobs(opts);
	const report = await runFleetOrThrow(opts.targets ?? TARGETS_FILE, {
		...(opts.history === true ? { history: true } : {}),
		...(opts.db ? { db: opts.db } : {}),
	});
	emit(format, {
		human: renderFleetTerminal(report),
		json: report,
		md: renderFleetMarkdown(report),
	} satisfies Rendered);
	const assessment = assessFleet(report);
	if (assessment.failed) throw new FailOnExit(assessment.reasons);
}

/** Run the fleet, converting a fleet-declaration {@link TargetsError} into a {@link CliError}. */
async function runFleetOrThrow(
	targets: string,
	opts: Parameters<typeof runFleetTargets>[1],
): ReturnType<typeof runFleetTargets> {
	try {
		return await runFleetTargets(targets, opts);
	} catch (error) {
		if (error instanceof TargetsError) throw new CliError(error.message, EXIT.ERROR);
		if (error instanceof AuditRunError || error instanceof LegacyConfigError) {
			throw new CliError(error.message, EXIT.ERROR);
		}
		throw error;
	}
}
