/**
 * Comparison renderers (SPEC §9, §12, trellis-9a88) — the terminal and
 * Markdown views of a {@link ReportComparison} between two saved §6.4 report
 * artifacts (the JSON view is the structured comparison itself). Both views
 * lead with comparability: an incompatible pair is reported explicitly with
 * its reasons (never silently compared, so no deltas exist to show), and
 * caveats (`configuration-unverifiable`, `source-scope-changed`) are always
 * printed beside a proceeded comparison. Deltas are bounded summaries with
 * totals printed; the index delta always carries its direction (`lower is
 * better`) and the scoring version (§3.4).
 *
 * Pure text shaping over already-compared artifacts — no I/O, no clock.
 */

import type { MetricDelta, MetricSide, ReportComparison } from "../compare/index.ts";
import type { AuditReport, Finding } from "../contract/index.ts";
import { findingLocation, formatNumber, repoLabel } from "./audit-format.ts";

/** Options for the comparison renderers. */
export interface ComparisonRenderOptions {
	/** Maximum metric-delta rows shown (bounded summary); the total is always printed. */
	metricLimit?: number;
	/** Maximum new/resolved findings listed each; the totals are always printed. */
	findingLimit?: number;
}

const DEFAULT_METRIC_LIMIT = 10;
const DEFAULT_FINDING_LIMIT = 10;

/** `+6` / `-2` / `0` — a signed delta with deterministic formatting. */
function formatDelta(delta: number): string {
	return delta > 0 ? `+${formatNumber(delta)}` : formatNumber(delta);
}

/** One side of a metric delta: the value, the state label, or `—` when absent. */
function formatSide(side: MetricSide | null): string {
	if (side === null) return "—";
	return side.value === undefined ? side.state : formatNumber(side.value);
}

/**
 * The metric deltas that actually moved: a non-zero value delta, an
 * appeared/disappeared side, a gained/lost value, or a state transition.
 * Two valueless sides in the same state (e.g. `not-applicable` on both) are
 * unchanged.
 */
function changedMetrics(deltas: readonly MetricDelta[]): MetricDelta[] {
	return deltas.filter((delta) => {
		if (delta.delta !== undefined) return delta.delta !== 0;
		const { baseline, current } = delta;
		if (baseline === null || current === null) return true;
		if ((baseline.value === undefined) !== (current.value === undefined)) return true;
		return baseline.state !== current.state;
	});
}

/** Compatibility block shared by both renderers: the verdict, issues, and caveats. */
function compatibilityLines(comparison: ReportComparison): string[] {
	const { compatibility } = comparison;
	const lines: string[] = [];
	if (compatibility.comparable) {
		lines.push("comparable: yes — measurement semantics match (SPEC §3.5)");
	} else {
		lines.push("comparable: NO — the reports were not compared:");
		for (const issue of compatibility.issues) lines.push(`  ${issue.code}: ${issue.message}`);
	}
	for (const caveat of compatibility.caveats) {
		lines.push(`  caveat (${caveat.code}): ${caveat.message}`);
	}
	return lines;
}

/** Bounded finding-list lines for one classification (`new` / `resolved`). */
function findingLines(title: string, findings: readonly Finding[], limit: number): string[] {
	if (findings.length === 0) return [];
	const lines = [`  ${title}:`];
	for (const finding of findings.slice(0, limit)) {
		lines.push(`    ${finding.kind} ${findingLocation(finding)} — ${finding.summary}`);
	}
	const rest = findings.length - Math.min(findings.length, limit);
	if (rest > 0) lines.push(`    … (+${rest} more)`);
	return lines;
}

/** Bounded markdown finding table for one classification (`new` / `resolved`). */
function findingTable(title: string, findings: readonly Finding[], limit: number): string[] {
	if (findings.length === 0) return [];
	const rows = [
		`### ${title} (${findings.length})`,
		"",
		"| kind | location | summary |",
		"| --- | --- | --- |",
	];
	for (const finding of findings.slice(0, limit)) {
		rows.push(
			`| ${cell(finding.kind)} | ${cell(findingLocation(finding))} | ${cell(finding.summary)} |`,
		);
	}
	const rest = findings.length - Math.min(findings.length, limit);
	if (rest > 0) rows.push(`| … | | +${rest} more |`);
	return rows;
}

/** Escape a value for a markdown table cell. */
function cell(text: string): string {
	return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

/** The terminal score-delta line: both indices, the signed delta, direction, and scoring version. */
function terminalScoreLine(comparison: ReportComparison, current: AuditReport): string[] {
	const score = comparison.score;
	if (score === undefined) return [];
	return [
		"",
		`index: ${formatNumber(score.baseline)}/100 → ${formatNumber(score.current)}/100 ` +
			`(${formatDelta(score.delta)}) · lower is better · scoring ${current.scoringVersion}`,
	];
}

/** The bounded terminal metric-delta list; the changed/total counts are always printed. */
function terminalMetricLines(comparison: ReportComparison, limit: number): string[] {
	if (comparison.metrics === undefined) return [];
	const changed = changedMetrics(comparison.metrics);
	const lines = ["", `metric deltas: ${changed.length} changed of ${comparison.metrics.length}`];
	for (const delta of changed.slice(0, limit)) {
		const movement = delta.delta === undefined ? "" : ` (${formatDelta(delta.delta)})`;
		lines.push(
			`  ${delta.id}: ${formatSide(delta.baseline)} → ${formatSide(delta.current)}${movement}`,
		);
	}
	const rest = changed.length - Math.min(changed.length, limit);
	if (rest > 0) lines.push(`  … (+${rest} more)`);
	return lines;
}

/** The terminal finding-classification block: counts plus bounded new/resolved lists. */
function terminalFindingLines(comparison: ReportComparison, limit: number): string[] {
	const findings = comparison.findings;
	if (findings === undefined) return [];
	return [
		"",
		`findings: ${findings.new.length} new · ${findings.resolved.length} resolved · ` +
			`${findings.persistent.length} persistent`,
		...findingLines("new", findings.new, limit),
		...findingLines("resolved", findings.resolved, limit),
	];
}

/**
 * Render a {@link ReportComparison} as plain terminal text (no ANSI — pipes
 * and CI logs stay clean). Pure: every number comes from the comparison.
 */
export function renderComparisonTerminal(
	comparison: ReportComparison,
	baseline: AuditReport,
	current: AuditReport,
	options: ComparisonRenderOptions = {},
): string {
	const lines: string[] = [
		`trellis compare · ${repoLabel(baseline)} → ${repoLabel(current)}`,
		...compatibilityLines(comparison),
		...terminalScoreLine(comparison, current),
		...terminalMetricLines(comparison, options.metricLimit ?? DEFAULT_METRIC_LIMIT),
		...terminalFindingLines(comparison, options.findingLimit ?? DEFAULT_FINDING_LIMIT),
	];
	return lines.join("\n");
}

/** The markdown index-delta section (a one-row table plus the direction/version note). */
function markdownScoreSection(comparison: ReportComparison, current: AuditReport): string[] {
	const score = comparison.score;
	if (score === undefined) return [];
	return [
		"",
		"## Index",
		"",
		"| baseline | current | delta |",
		"| --- | --- | --- |",
		`| ${formatNumber(score.baseline)}/100 | ${formatNumber(score.current)}/100 | ${formatDelta(score.delta)} |`,
		"",
		`Lower is better · scoring ${current.scoringVersion}.`,
	];
}

/** The bounded markdown metric-delta table; the changed/total counts are always printed. */
function markdownMetricSection(comparison: ReportComparison, limit: number): string[] {
	if (comparison.metrics === undefined) return [];
	const changed = changedMetrics(comparison.metrics);
	const lines = [
		"",
		`## Metric deltas (${changed.length} changed of ${comparison.metrics.length})`,
		"",
	];
	if (changed.length === 0) return lines;
	lines.push("| metric | baseline | current | delta |", "| --- | --- | --- | --- |");
	for (const delta of changed.slice(0, limit)) {
		lines.push(
			`| ${cell(delta.id)} | ${formatSide(delta.baseline)} | ${formatSide(delta.current)} | ` +
				`${delta.delta === undefined ? "—" : formatDelta(delta.delta)} |`,
		);
	}
	const rest = changed.length - Math.min(changed.length, limit);
	if (rest > 0) lines.push(`| … | | | +${rest} more |`);
	return lines;
}

/** The markdown finding-classification section: counts plus bounded new/resolved tables. */
function markdownFindingSection(comparison: ReportComparison, limit: number): string[] {
	const findings = comparison.findings;
	if (findings === undefined) return [];
	return [
		"",
		"## Findings",
		"",
		`${findings.new.length} new · ${findings.resolved.length} resolved · ` +
			`${findings.persistent.length} persistent`,
		"",
		...findingTable("New", findings.new, limit),
		...findingTable("Resolved", findings.resolved, limit),
	];
}

/**
 * Render a {@link ReportComparison} as a bounded Markdown summary for pull
 * requests and docs. Same numbers as the terminal view — the JSON comparison
 * remains the full structured document.
 */
export function renderComparisonMarkdown(
	comparison: ReportComparison,
	baseline: AuditReport,
	current: AuditReport,
	options: ComparisonRenderOptions = {},
): string {
	const lines: string[] = [
		`# trellis compare — ${repoLabel(baseline)} → ${repoLabel(current)}`,
		"",
		...compatibilityLines(comparison).map((line) => line.trimStart()),
		...markdownScoreSection(comparison, current),
		...markdownMetricSection(comparison, options.metricLimit ?? DEFAULT_METRIC_LIMIT),
		...markdownFindingSection(comparison, options.findingLimit ?? DEFAULT_FINDING_LIMIT),
	];
	return lines.join("\n");
}
