/**
 * `trellis fleet` — audit every target in a `targets.yaml` (SPEC §6.5, §12).
 *
 * Thin per SPEC §13.1: load the rubric once, call the core {@link runFleetTargets}
 * service (load + validate the fleet, audit + drift each target, persist every
 * run, compute per-repo level deltas), shape the three output variants, then
 * apply the {@link assessFleet} exit-code policy. Each target's audit honors its
 * `allowedDeltas` and `skip`; a missing path or a per-target failure is
 * isolated into an error row without aborting the fleet. `--db`
 * overrides the central DB. Transitional (SPEC §14 stage 2): the retired
 * investigation knobs — `--no-cache`, `TRELLIS_PI_BIN`, and `targets.yaml`
 * `defaults.investigation` — are rejected with an actionable error.
 *
 * Exit codes (SPEC §12): `0` clean; `2` when `--fail-on` trips for any target
 * (default: a gate criterion fails OR drift is detected; an unauditable target
 * always trips); `1` on an operational error. `--fail-on level` compares each
 * target's level against `--min-level` (default 3).
 */
import type { Command } from "commander";
import { Option } from "commander";
import {
	assessFleet,
	renderFleetMarkdown,
	renderFleetTerminal,
	runFleetTargets,
	TARGETS_FILE,
	TargetsError,
} from "../fleet/index.ts";
import { legacyConfigMessage } from "../legacy.ts";
import { loadRubric, type Rubric, RubricError } from "../rubric/index.ts";
import { failPolicy } from "./fail-on.ts";
import { CliError, EXIT, emit, FailOnExit, type Rendered, resolveFormat } from "./output.ts";

/** Local options for the fleet command, merged with the global format flags. */
interface FleetCliOptions {
	json?: boolean;
	md?: boolean;
	targets?: string;
	/** Retired (`--no-cache`): kept as a hidden flag so passing it errors actionably. */
	cache?: boolean;
	/** SQLite history path; defaults to `TRELLIS_DB` env or `~/.trellis/trellis.db`. */
	db?: string;
	/** Exit-code policy (SPEC §12). */
	failOn?: string;
	minLevel?: string;
}

/** Register the `fleet` subcommand on `program`. */
export function registerFleet(program: Command): void {
	program
		.command("fleet")
		.description("audit every target in targets.yaml")
		.option("--targets <file>", "fleet declaration", TARGETS_FILE)
		.addOption(new Option("--no-cache", "retired: no investigation pass remains").hideHelp())
		.addOption(
			new Option(
				"--fail-on <mode>",
				"exit non-zero on: gate|drift|level|none (default: gate or drift)",
			).choices(["gate", "drift", "level", "none"]),
		)
		.option("--min-level <n>", "minimum level for --fail-on level (1–5, default 3)")
		.addOption(new Option("--db <path>", "SQLite history path").hideHelp())
		.action(function (this: Command) {
			return runFleetCommand(this.optsWithGlobals() as FleetCliOptions);
		});
}

/** Load the fleet + rubric, run every target through core, emit, then apply the exit policy. */
async function runFleetCommand(opts: FleetCliOptions): Promise<void> {
	const format = resolveFormat(opts);
	const policy = failPolicy(opts);
	const targets = opts.targets ?? TARGETS_FILE;
	const rubric = loadRubricOrThrow();
	// Retired investigation knobs fail fast with an actionable message (SPEC §14 stage 2).
	if (opts.cache === false) throw new CliError(legacyConfigMessage("--no-cache"));
	if (process.env.TRELLIS_PI_BIN?.trim()) {
		throw new CliError(legacyConfigMessage("TRELLIS_PI_BIN"));
	}
	const report = await runFleetOrThrow(targets, {
		rubric,
		...(opts.db ? { db: opts.db } : {}),
	});
	emit(format, {
		human: renderFleetTerminal(report),
		json: report,
		md: renderFleetMarkdown(report),
	} satisfies Rendered);
	const assessment = assessFleet(report, policy);
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
		throw error;
	}
}

/** Load the rubric once for the whole fleet, converting a {@link RubricError} into a {@link CliError}. */
function loadRubricOrThrow(): Rubric {
	try {
		return loadRubric();
	} catch (error) {
		if (error instanceof RubricError) {
			throw new CliError(error.message, EXIT.ERROR, { id: error.id, file: error.file });
		}
		throw error;
	}
}
