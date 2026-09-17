/**
 * Comparison and policy renderers (SPEC §9, §12, trellis-9a88) — the terminal
 * and Markdown views of a {@link import("../compare/index.ts").ReportComparison}
 * (baseline vs current) and a {@link import("../compare/index.ts").PolicyAssessment}.
 * Pure text shaping over the compare layer's structured results — no I/O, no
 * re-computation — so the CLI's `compare` command and the `audit --baseline`
 * appendix can never disagree about a delta or a reason. JSON carries the
 * structured objects themselves; these are the human views.
 *
 * Presentation rules (shared with `audit-format.ts`):
 *
 * - The index delta always carries its direction (`lower is better`) — a
 *   positive delta is a regression, never a percentage.
 * - Lists are bounded; the total is always printed beside the shown slice.
 * - An incompatible comparison renders its issues explicitly and invents no
 *   deltas (the compare layer computed none).
 */
import type {
	CompatibilityIssue,
	MetricDelta,
	MetricSide,
	PolicyAssessment,
	PolicyResult,
	ReportComparison,
} from "../compare/index.ts";
import { formatNumber } from "./audit-format.ts";

/** Default bound for the changed-metric list; the total changed count is always printed. */
export const DEFAULT_DELTA_LIMIT = 20;

/** One metric side as text: value, bare state when valueless, or an em dash when absent. */
function sideText(side: MetricSide | null): string {
	if (side === null) return "—";
	return side.value === undefined ? side.state : formatNumber(side.value);
}

/** A signed delta (`+6`, `-2`, `0`); an em dash when no numeric delta exists. */
function deltaText(delta: number | undefined): string {
	if (delta === undefined) return "—";
	return delta > 0 ? `+${formatNumber(delta)}` : formatNumber(delta);
}

/** The changed metrics (value delta, state change, or one-sided presence), bounded; the total is always reported. */
function changedMetrics(
	comparison: ReportComparison,
	limit: number,
): { shown: MetricDelta[]; total: number } {
	const changed = (comparison.metrics ?? []).filter((delta) => {
		if (delta.baseline === null || delta.current === null) return true;
		if (delta.baseline.state !== delta.current.state) return true;
		return delta.delta !== undefined && delta.delta !== 0;
	});
	return { shown: changed.slice(0, limit), total: changed.length };
}

/** `- <code>: <message>` lines for a list of compatibility issues/caveats. */
function issueLines(issues: readonly CompatibilityIssue[]): string[] {
	return issues.map((issue) => `  - ${issue.code}: ${issue.message}`);
}

/** A one-word policy status: `pass`, loud `FAIL`, or `skip`. */
function statusLabel(result: PolicyResult): string {
	switch (result.status) {
		case "pass":
			return "pass";
		case "fail":
			return "FAIL";
		case "skipped":
			return "skip";
	}
}

/** The policy's subject suffix (` "metric.id"`), or empty when the policy has none. */
function subjectText(result: PolicyResult): string {
	return result.subject === undefined ? "" : ` "${result.subject}"`;
}

/** Terminal lines for one policy result: status, subject, and its reasons. */
function policyLines(result: PolicyResult): string[] {
	const lines = [`  ${statusLabel(result)} ${result.policy}${subjectText(result)}`];
	for (const reason of result.reasons) lines.push(`    ${reason.message}`);
	return lines;
}

/**
 * Render a {@link PolicyAssessment} as terminal text: one block per evaluated
 * policy with its coded reasons. With no configured policies the assessment
 * carries no results and this renders an empty string (callers omit the block).
 */
export function renderPolicyTerminal(policy: PolicyAssessment): string {
	const lines = [`policy: ${policy.failed ? "FAILED" : "clean"}`];
	for (const result of policy.results) lines.push(...policyLines(result));
	return lines.join("\n");
}

/** Render a {@link PolicyAssessment} as a Markdown table with a verdict line. */
export function renderPolicyMarkdown(policy: PolicyAssessment): string {
	const lines = [
		`**Policy:** ${policy.failed ? "FAILED" : "clean"}`,
		"",
		"| Policy | Subject | Status | Reasons |",
		"| --- | --- | --- | --- |",
	];
	for (const result of policy.results) {
		const reasons = result.reasons.map((reason) => reason.message).join("<br>");
		lines.push(
			`| ${result.policy} | ${result.subject ?? "—"} | ${statusLabel(result)} | ${cell(reasons || "—")} |`,
		);
	}
	return lines.join("\n");
}

/**
 * Render a {@link ReportComparison} as terminal text (SPEC §9): compatibility
 * first (an incompatible pair shows its issues and nothing else), then the
 * score delta, the three-way finding classification, and a bounded table of
 * changed metrics. Caveats are always explicit.
 */
export function renderComparisonTerminal(
	comparison: ReportComparison,
	options: { deltaLimit?: number } = {},
): string {
	const lines: string[] = [];
	if (!comparison.compatibility.comparable) {
		lines.push("compatibility: NOT comparable — no deltas computed");
		lines.push(...issueLines(comparison.compatibility.issues));
		return lines.join("\n");
	}
	lines.push("compatibility: comparable");
	if (comparison.compatibility.caveats.length > 0) {
		lines.push("caveats:");
		lines.push(...issueLines(comparison.compatibility.caveats));
	}
	const score = comparison.score;
	if (score !== undefined) {
		lines.push(
			`score: ${formatNumber(score.baseline)} → ${formatNumber(score.current)} (${deltaText(score.delta)}, lower is better)`,
		);
	}
	const findings = comparison.findings;
	if (findings !== undefined) {
		lines.push(
			`findings: ${findings.new.length} new · ${findings.resolved.length} resolved · ${findings.persistent.length} persistent`,
		);
	}
	const changed = changedMetrics(comparison, options.deltaLimit ?? DEFAULT_DELTA_LIMIT);
	if (changed.total > 0) {
		lines.push(`metric deltas (${changed.total} changed):`);
		for (const delta of changed.shown) {
			lines.push(
				`  ${delta.id}: ${sideText(delta.baseline)} → ${sideText(delta.current)} (${deltaText(delta.delta)})`,
			);
		}
		if (changed.shown.length < changed.total) {
			lines.push(`  … +${changed.total - changed.shown.length} more`);
		}
	}
	return lines.join("\n");
}

/** Escape a value for a table cell (pipes and newlines would break the table). */
function cell(text: string): string {
	return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

/** Render a {@link ReportComparison} as a bounded Markdown summary (SPEC §12). */
export function renderComparisonMarkdown(
	comparison: ReportComparison,
	options: { deltaLimit?: number } = {},
): string {
	if (!comparison.compatibility.comparable) {
		return [
			"**Compatibility:** NOT comparable — no deltas computed",
			"",
			...comparison.compatibility.issues.map((issue) => `- \`${issue.code}\` — ${issue.message}`),
		].join("\n");
	}
	const lines: string[] = ["**Compatibility:** comparable"];
	if (comparison.compatibility.caveats.length > 0) {
		lines.push(
			"",
			"**Caveats:**",
			"",
			...comparison.compatibility.caveats.map((issue) => `- \`${issue.code}\` — ${issue.message}`),
		);
	}
	const score = comparison.score;
	if (score !== undefined) {
		lines.push(
			"",
			`**Score:** ${formatNumber(score.baseline)} → ${formatNumber(score.current)} (${deltaText(score.delta)}, lower is better)`,
		);
	}
	const findings = comparison.findings;
	if (findings !== undefined) {
		lines.push(
			"",
			`**Findings:** ${findings.new.length} new · ${findings.resolved.length} resolved · ${findings.persistent.length} persistent`,
		);
	}
	const changed = changedMetrics(comparison, options.deltaLimit ?? DEFAULT_DELTA_LIMIT);
	if (changed.total > 0) {
		lines.push(
			"",
			`### Metric deltas (${changed.total} changed)`,
			"",
			"| Metric | Baseline | Current | Δ |",
			"| --- | --- | --- | --- |",
		);
		for (const delta of changed.shown) {
			lines.push(
				`| ${delta.id} | ${sideText(delta.baseline)} | ${sideText(delta.current)} | ${deltaText(delta.delta)} |`,
			);
		}
		if (changed.shown.length < changed.total) {
			lines.push(`| … | +${changed.total - changed.shown.length} more | | |`);
		}
	}
	return lines.join("\n");
}
