/**
 * `trellis drift <repo-path>` — canonical-config drift only (SPEC §10, §12).
 *
 * Thin per SPEC §13.1: it calls the core {@link driftRepo} and shapes the three
 * output variants. Run standalone (no fleet context), allowed deltas default to
 * empty — every non-whitelisted divergence reads as `drift`. `--canonical <v>`
 * pins the canonical set version; an unbundled version surfaces as a
 * {@link CliError}.
 *
 * Exit codes (SPEC §12): `0` clean; `2` when drift is detected (the default;
 * `--fail-on none` disables it); `1` on an operational error. Only the `drift`
 * dimension applies here — there is no scorecard to gate on.
 */
import type { Command } from "commander";
import { Option } from "commander";
import {
	DriftError,
	driftRepo,
	failingDriftCount,
	hasFailingDrift,
	renderDriftMarkdown,
	renderDriftTerminal,
} from "../standards/index.ts";
import { CliError, EXIT, emit, FailOnExit, type Rendered, resolveFormat } from "./output.ts";

/** Local options for the drift command, merged with the global format flags. */
interface DriftCliOptions {
	json?: boolean;
	md?: boolean;
	canonical?: string;
	failOn?: string;
}

/** Register the `drift` subcommand on `program`. */
export function registerDrift(program: Command): void {
	program
		.command("drift")
		.argument("<repo-path>", "path to the repository to compare")
		.description("L1 canonical-config drift only")
		.option("--canonical <v>", "pin the canonical standards version")
		.addOption(
			new Option("--fail-on <mode>", "exit non-zero on: drift|none (default: drift)").choices([
				"drift",
				"none",
			]),
		)
		.action(function (this: Command, repoPath: string) {
			runDrift(repoPath, this.optsWithGlobals() as DriftCliOptions);
		});
}

/** Run the core drift comparison, emit it, then apply the exit-code policy. */
function runDrift(repoPath: string, opts: DriftCliOptions): void {
	const format = resolveFormat(opts);
	let report: ReturnType<typeof driftRepo>;
	try {
		report = driftRepo(repoPath, opts.canonical ? { canonicalVersion: opts.canonical } : {});
	} catch (error) {
		if (error instanceof DriftError) throw new CliError(error.message, EXIT.ERROR);
		throw error;
	}
	emit(format, {
		human: renderDriftTerminal(report),
		json: report,
		md: renderDriftMarkdown(report),
	} satisfies Rendered);
	if (opts.failOn !== "none" && hasFailingDrift(report.summary)) {
		throw new FailOnExit([`canonical drift detected (${failingDriftCount(report.summary)} files)`]);
	}
}
