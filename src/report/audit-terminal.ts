/**
 * Terminal renderer for the §6.4 metric report (SPEC §12, trellis-a059) —
 * the default human view of a deterministic audit. Pure text (no ANSI —
 * composes cleanly with pipes and CI logs) and a bounded summary: the
 * headline index with its direction and scoring version, source coverage,
 * score contributions traceable to raw metrics, the raw metric table,
 * ranked hotspots (bounded; the total is always printed), remaining located
 * findings, and safeguard evidence (never folded into the score). When the
 * report carries external provider analyses (an explicitly requested
 * optional provider), a distinct evidence section follows: every carried
 * analysis's state, provenance and asserted coverage, with overall
 * evidence completeness kept visible and separate from the score (see
 * `./audit-terminal-providers.ts`) — a default native-only audit renders
 * byte-identically, with no provider noise.
 *
 * All numbers and locations come from {@link ./audit-format.ts} so this view
 * can never disagree with the JSON/Markdown ones, and no readiness levels,
 * agent progress, or legacy category labels can appear here — the §6.4
 * report does not carry them.
 */
import type { AuditReport } from "../contract/index.ts";
import {
	boundFindings,
	coverageRows,
	DEFAULT_HOTSPOT_LIMIT,
	findingLocation,
	formatLocation,
	formatMetric,
	formatNumber,
	hotspotFindings,
	otherFindings,
	repoLabel,
	scoreHeadline,
	sortedMetrics,
} from "./audit-format.ts";
import { providerAnalysisLines } from "./audit-terminal-providers.ts";

/** Options for {@link renderAuditTerminal}. */
export interface AuditTerminalOptions {
	/** Maximum ranked hotspots shown (bounded summary); the total is always printed. */
	hotspotLimit?: number;
	/** Maximum non-hotspot findings shown; the total is always printed. */
	findingLimit?: number;
	/** Maximum provider findings shown per optional analysis; the total is always printed. */
	providerFindingLimit?: number;
}

/** Right-pad `s` to `width` for fixed-width columns. */
function pad(s: string, width: number): string {
	return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/** Left-pad `s` to `width` for right-aligned numeric columns. */
function padStart(s: string, width: number): string {
	return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

/** The headline block: title, score (direction + version), completeness, run metadata. */
function headerLines(report: AuditReport): string[] {
	const lines = [
		`trellis audit · ${repoLabel(report)}`,
		scoreHeadline(report),
		`completeness: ${report.completeness}`,
	];
	if (report.run?.auditedAt !== undefined) {
		const duration =
			report.run.durationMs === undefined ? "" : ` · ${formatNumber(report.run.durationMs)}ms`;
		lines.push(`audited ${report.run.auditedAt}${duration}`);
	}
	return lines;
}

/** The source-coverage block: one line per non-empty scope (§3.1). */
function coverageLines(report: AuditReport): string[] {
	const rows = coverageRows(report.sourceCoverage);
	const scopeWidth = Math.max(5, ...rows.map((row) => row.scope.length));
	return [
		"source coverage",
		...rows.map((row) => {
			const parts = [`${row.files} file${row.files === 1 ? "" : "s"}`];
			if (row.sloc !== undefined) parts.push(`${row.sloc} sloc`);
			if (row.note !== undefined) parts.push(row.note);
			return `  ${pad(row.scope, scopeWidth)}  ${parts.join(" · ")}`;
		}),
	];
}

/** The score-contribution block: per-dimension points with their traceable raw metrics (§7). */
function contributionLines(report: AuditReport): string[] {
	const contributions = report.score.contributions;
	const dimensionWidth = Math.max(9, ...contributions.map((c) => c.dimension.length));
	return [
		"score contributions (traceable to raw metrics)",
		...contributions.map(
			(contribution) =>
				`  ${pad(contribution.dimension, dimensionWidth)}  ` +
				`${padStart(formatNumber(contribution.points), 3)} pts · ${contribution.metricIds.join(", ")}`,
		),
	];
}

/** The raw-metric block: every metric, state-aware (§3.3, §6.1). */
function metricLines(report: AuditReport): string[] {
	const metrics = sortedMetrics(report);
	const idWidth = Math.max(6, ...metrics.map((metric) => metric.id.length));
	return [
		"metrics",
		...metrics.map((metric) => `  ${pad(metric.id, idWidth)}  ${formatMetric(metric)}`),
	];
}

/** One bounded finding block (header + located rows); empty when there are none. */
function boundedFindingLines(
	title: string,
	findings: ReturnType<typeof boundFindings>,
	options: { ranked?: boolean; noneLabel?: string } = {},
): string[] {
	if (findings.total === 0) {
		return options.noneLabel === undefined ? [] : [options.noneLabel];
	}
	const header = options.ranked
		? `${title} (top ${findings.shown.length} of ${findings.total})`
		: `${title} (${findings.shown.length} of ${findings.total})`;
	const kindWidth = Math.max(4, ...findings.shown.map((finding) => finding.kind.length));
	return [
		header,
		...findings.shown.map(
			(finding) =>
				`  ${pad(finding.kind, kindWidth)}  ${findingLocation(finding)} · ${finding.summary}`,
		),
	];
}

/** The safeguard block: configuration evidence, explicitly outside the score (§5.5). */
function safeguardLines(report: AuditReport): string[] {
	const idWidth = Math.max(9, ...report.safeguards.map((result) => result.id.length));
	return [
		"safeguards (configuration evidence — never folded into the score)",
		...report.safeguards.map((result) => {
			const locations = result.locations
				.map((location) => formatLocation(location.path, location.range))
				.join(", ");
			const where = locations === "" ? "" : ` · ${locations}`;
			const notes = result.notes === undefined ? "" : ` · ${result.notes}`;
			return `  ${pad(result.id, idWidth)}  ${result.evidence}${where}${notes}`;
		}),
	];
}

/** Render a §6.4 audit report as the default human-readable terminal summary. */
export function renderAuditTerminal(
	report: AuditReport,
	options: AuditTerminalOptions = {},
): string {
	const sections = [
		headerLines(report),
		coverageLines(report),
		contributionLines(report),
		metricLines(report),
		boundedFindingLines(
			"hotspots",
			boundFindings(hotspotFindings(report), options.hotspotLimit ?? DEFAULT_HOTSPOT_LIMIT),
			{ ranked: true, noneLabel: "hotspots: none" },
		),
		boundedFindingLines(
			"findings",
			boundFindings(otherFindings(report), options.findingLimit ?? DEFAULT_HOTSPOT_LIMIT),
		),
		safeguardLines(report),
		providerAnalysisLines(report, options.providerFindingLimit ?? DEFAULT_HOTSPOT_LIMIT),
	].filter((section) => section.length > 0);
	return sections.map((section) => section.join("\n")).join("\n\n");
}
