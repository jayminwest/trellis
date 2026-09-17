/**
 * `trellis compare <baseline.json> <current.json>` — compare two saved report
 * artifacts without running an audit (SPEC §9, §12). Thin per SPEC §13.1:
 * parse flags, call the core {@link runComparison} service (load + re-validate
 * both artifacts → pure comparison → optional policy), shape the three output
 * variants, then map the outcome onto the exit-code contract.
 *
 * Comparability is explicit (SPEC §9): an incompatible pair is reported, never
 * silently compared, and fails closed — the comparison summary is still
 * emitted to stdout and the incompatibility reasons go to stderr with exit
 * `2`, exactly like a tripped policy. With `--config <trellis.yaml>`, the
 * file's declarative `policy` block gates the comparison (the current
 * artifact is the subject, the baseline artifact the reference); without it,
 * the comparison alone gates nothing.
 *
 * Exit codes (SPEC §9): `0` clean; `2` when the pair is incompatible or a
 * configured policy trips (report still emitted); `1` on an operational
 * error (an unreadable/invalid artifact or configuration file).
 */
import type { Command } from "commander";
import { type CompareRunResult, runComparison } from "../compare/index.ts";
import { renderComparisonMarkdown, renderComparisonTerminal } from "../report/index.ts";
import { CliError, EXIT, emit, FailOnExit, type Rendered, resolveFormat } from "./output.ts";

/** Local options for the compare command, merged with the global format flags. */
interface CompareCliOptions {
	json?: boolean;
	md?: boolean;
	/** Explicit `trellis.yaml` whose `policy` block gates the comparison. */
	config?: string;
}

/** Register the `compare` subcommand on `program`. */
export function registerCompare(program: Command): void {
	program
		.command("compare")
		.argument("<baseline.json>", "saved baseline report artifact")
		.argument("<current.json>", "saved current report artifact")
		.description("compare two saved report artifacts without an audit")
		.option("--config <file>", "trellis.yaml whose policy block gates the comparison")
		.action(function (this: Command, baselinePath: string, currentPath: string) {
			return runCompareCommand(
				baselinePath,
				currentPath,
				this.optsWithGlobals() as CompareCliOptions,
			);
		});
}

/** One stderr line per hard incompatibility (the fail-closed reasons, SPEC §9). */
function incompatibilityLines(result: CompareRunResult): string[] {
	return result.comparison.compatibility.issues.map(
		(issue) => `the reports are not comparable (${issue.code}): ${issue.message}`,
	);
}

/** One stderr line per failed policy reason. */
function policyReasonLines(result: CompareRunResult): string[] {
	if (result.policy === null) return [];
	const lines: string[] = [];
	for (const policyResult of result.policy.results) {
		if (policyResult.status !== "fail") continue;
		for (const reason of policyResult.reasons) {
			lines.push(`policy ${policyResult.policy} failed: ${reason.message}`);
		}
	}
	return lines;
}

/** Run the core comparison service, emit the comparison, then apply the exit-code contract. */
async function runCompareCommand(
	baselinePath: string,
	currentPath: string,
	opts: CompareCliOptions,
): Promise<void> {
	const format = resolveFormat(opts);
	let result: CompareRunResult;
	try {
		result = await runComparison(baselinePath, currentPath, {
			...(opts.config ? { configPath: opts.config } : {}),
		});
	} catch (error) {
		// Every service failure is operational (SPEC §9): the comparison could
		// not run, so nothing was emitted — exit 1 with the reason.
		if (error instanceof CliError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new CliError(message, EXIT.ERROR);
	}
	emit(format, {
		human: renderComparisonTerminal(result.comparison, result.baseline, result.current),
		json: result.comparison,
		md: renderComparisonMarkdown(result.comparison, result.baseline, result.current),
	} satisfies Rendered);
	const reasons = [
		...(result.comparison.compatibility.comparable ? [] : incompatibilityLines(result)),
		...(result.policy?.failed === true ? policyReasonLines(result) : []),
	];
	if (reasons.length > 0) throw new FailOnExit(reasons);
}
