/**
 * `trellis drift <repo-path>` — canonical-config drift only (SPEC §10, §12).
 *
 * Thin per SPEC §13.1: it calls the core {@link driftRepo} and shapes the three
 * output variants. Run standalone (no fleet context), allowed deltas default to
 * empty — every non-whitelisted divergence reads as `drift`. `--canonical <v>`
 * pins the canonical set version; an unbundled version surfaces as a
 * {@link CliError}. Exit is always `0` here — the `--fail-on drift` contract
 * lands with the SDK exit-code step (trellis-28a5).
 */
import type { Command } from "commander";
import {
	DriftError,
	driftRepo,
	renderDriftMarkdown,
	renderDriftTerminal,
} from "../standards/index.ts";
import { CliError, EXIT, emit, type Rendered, resolveFormat } from "./output.ts";

/** Local options for the drift command, merged with the global format flags. */
interface DriftCliOptions {
	json?: boolean;
	md?: boolean;
	canonical?: string;
}

/** Register the `drift` subcommand on `program`. */
export function registerDrift(program: Command): void {
	program
		.command("drift")
		.argument("<repo-path>", "path to the repository to compare")
		.description("L1 canonical-config drift only")
		.option("--canonical <v>", "pin the canonical standards version")
		.action(function (this: Command, repoPath: string) {
			runDrift(repoPath, this.optsWithGlobals() as DriftCliOptions);
		});
}

/** Run the core drift comparison and emit the chosen output variant. */
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
}
