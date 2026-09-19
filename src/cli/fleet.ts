/** CLI fleet command over the deterministic core and per-target policy assessment. */
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
}

/** Register the `fleet` subcommand on `program`. */
export function registerFleet(program: Command): void {
	program
		.command("fleet")
		.description("audit every target in targets.yaml")
		.option("--targets <file>", "fleet declaration", TARGETS_FILE)
		.option("--history", "record each target's run in the central history (opt-in)")
		.addOption(new Option("--db <path>", "SQLite history path").hideHelp())

		.action(function (this: Command) {
			return runFleetCommand(this.optsWithGlobals() as FleetCliOptions);
		});
}

/** Load the fleet, run every target through core, emit, then apply the exit rollup. */
async function runFleetCommand(opts: FleetCliOptions): Promise<void> {
	const format = resolveFormat(opts);
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
		if (error instanceof AuditRunError) {
			throw new CliError(error.message, EXIT.ERROR);
		}
		throw error;
	}
}
