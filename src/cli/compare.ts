/**
 * `trellis compare <baseline.json> <current.json>` — artifact comparison
 * without an audit (SPEC §9, §12, trellis-9a88). Thin per SPEC §13.1: it calls
 * the core {@link compareArtifacts} (read + re-validate both saved JSON
 * reports, then the pure comparator) and shapes the three output variants.
 * No Git, no SQLite, no measurement — two saved reports compare directly.
 *
 * Exit codes (SPEC §9): `0` when the pair is comparable (deltas are
 * reported); `2` when the pair is **not comparable** — the comparison is
 * still emitted to stdout with its explicit issues, and the reasons go to
 * stderr; `1` on an operational error (an unreadable or invalid artifact).
 */
import type { Command } from "commander";
import { compareArtifacts, ReportArtifactError } from "../compare/index.ts";
import { renderComparisonMarkdown, renderComparisonTerminal } from "../report/index.ts";
import { CliError, EXIT, emit, FailOnExit, type Rendered, resolveFormat } from "./output.ts";

/** Local options for the compare command, merged with the global format flags. */
interface CompareCliOptions {
	json?: boolean;
	md?: boolean;
}

/** Register the `compare` subcommand on `program`. */
export function registerCompare(program: Command): void {
	program
		.command("compare")
		.argument("<baseline.json>", "the earlier saved audit report")
		.argument("<current.json>", "the later saved audit report")
		.description("compare two saved audit reports without an audit")
		.action(function (this: Command, baselinePath: string, currentPath: string) {
			return runCompareCommand(
				baselinePath,
				currentPath,
				this.optsWithGlobals() as CompareCliOptions,
			);
		});
}

/** Load both artifacts, compare them, emit, then map comparability onto the exit code. */
async function runCompareCommand(
	baselinePath: string,
	currentPath: string,
	opts: CompareCliOptions,
): Promise<void> {
	const format = resolveFormat(opts);
	let comparison: Awaited<ReturnType<typeof compareArtifacts>>;
	try {
		comparison = await compareArtifacts(baselinePath, currentPath);
	} catch (error) {
		if (error instanceof ReportArtifactError) throw new CliError(error.message, EXIT.ERROR);
		throw error;
	}
	emit(format, {
		human: renderComparisonTerminal(comparison),
		json: comparison,
		md: renderComparisonMarkdown(comparison),
	} satisfies Rendered);
	if (!comparison.compatibility.comparable) {
		throw new FailOnExit(
			comparison.compatibility.issues.map((issue) => `not comparable: ${issue.message}`),
		);
	}
}
