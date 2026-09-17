/**
 * Shared presentation helpers for the §6.4 metric-report renderers
 * (SPEC §12, trellis-a059). Everything here is pure text shaping over the
 * contract {@link import("../contract/index.ts").AuditReport} — no I/O, no
 * clock, no re-measurement — so the terminal, JSON, and Markdown views can
 * never disagree about a number, a location, or a ranking.
 *
 * Presentation rules pinned here (SPEC §3.4, §12):
 *
 * - The sloppiness index is always rendered with its direction
 *   (`lower is better`) and the scoring version, as `N/100` — never as a
 *   percentage, so output can never read as "percent of bad code".
 * - Findings render as usable relative locations: `path:line` or
 *   `path:start-end` (1-based lines; the end is omitted when it equals the
 *   start).
 * - Hotspots are the ranked measurement findings (complexity hotspots,
 *   clone groups, import cycles); producers rank within their kind and the
 *   report's deterministic order is preserved — renderers only bound the
 *   list, they never re-rank it.
 */
import {
	type AuditReport,
	COVERAGE_SCOPES,
	type Finding,
	type MetricValue,
	type Range,
	type SourceCoverage,
} from "../contract/index.ts";

/** Finding kinds that are ranked measurement hotspots (SPEC §5). */
export const HOTSPOT_KINDS = [
	"complexity.hotspot",
	"duplication.clone-group",
	"import-cycle",
] as const;

/** Default bound for hotspot/finding lists in the bounded summaries (SPEC §12). */
export const DEFAULT_HOTSPOT_LIMIT = 10;

/** Human-readable score directions, keyed by the contract literal (§3.4). */
const DIRECTION_LABELS: Record<string, string> = {
	"lower-is-better": "lower is better",
};

/** Deterministic number formatting: integers stay integers, decimals trim to ≤4 places. */
export function formatNumber(value: number): string {
	return String(Number(value.toFixed(4)));
}

/** `path:start` or `path:start-end` (1-based lines; end omitted when it equals the start). */
export function formatLocation(path: string, range?: Range): string {
	if (range === undefined) return path;
	return range.end.line === range.start.line
		? `${path}:${range.start.line}`
		: `${path}:${range.start.line}-${range.end.line}`;
}

/** A finding's usable relative location (`path:line[-line]`, SPEC §6.2). */
export function findingLocation(finding: Finding): string {
	return formatLocation(finding.path, finding.range);
}

/**
 * State-aware metric rendering (SPEC §3.3, §6.1). A complete metric shows
 * `value unit` plus its raw numerator/denominator pair when carried; an
 * incomplete metric always says what could not be analyzed (with its partial
 * value when one exists); `not-applicable`/`unsupported` never invent a value.
 */
/** Human unit suffix; bare `count` metrics read better without one. */
function unitSuffix(metric: MetricValue): string {
	return metric.unit === "count" ? "" : ` ${metric.unit}`;
}

export function formatMetric(metric: MetricValue): string {
	switch (metric.state) {
		case "complete": {
			const pair =
				metric.numerator !== undefined && metric.denominator !== undefined
					? ` (${formatNumber(metric.numerator)}/${formatNumber(metric.denominator)})`
					: "";
			return `${formatNumber(metric.value ?? 0)}${unitSuffix(metric)}${pair}`;
		}
		case "incomplete": {
			const partial =
				metric.value === undefined ? "" : `${formatNumber(metric.value)}${unitSuffix(metric)} · `;
			return `${partial}incomplete — ${metric.reason ?? "analysis did not finish"}`;
		}
		case "not-applicable":
			return "n/a";
		case "unsupported":
			return "unsupported";
	}
}

/** The report's metrics sorted by id (defensive — the core builds the map sorted). */
export function sortedMetrics(report: AuditReport): MetricValue[] {
	return Object.values(report.metrics).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The ranked measurement findings (hotspots), in the report's deterministic order (§3.2). */
export function hotspotFindings(report: AuditReport): Finding[] {
	const kinds = new Set<string>(HOTSPOT_KINDS);
	return report.findings.filter((finding) => kinds.has(finding.kind));
}

/** Located evidence that is not a ranked hotspot (unresolved imports, broken safeguard references). */
export function otherFindings(report: AuditReport): Finding[] {
	const kinds = new Set<string>(HOTSPOT_KINDS);
	return report.findings.filter((finding) => !kinds.has(finding.kind));
}

/** A bounded view over a finding list; the total is always reported beside the shown slice. */
export interface BoundedFindings {
	shown: Finding[];
	total: number;
}

/** Bound a finding list without re-ranking it (bounded summaries, SPEC §12). */
export function boundFindings(findings: readonly Finding[], limit: number): BoundedFindings {
	return { shown: findings.slice(0, limit), total: findings.length };
}

/**
 * The one headline line (SPEC §3.4, §12): the index with its direction and
 * the scoring version, as `N/100` — never a percentage. A partial headline
 * (missing analysis) is flagged on the same line, so an incomplete report
 * can never look like a clean bill.
 */
export function scoreHeadline(report: AuditReport): string {
	const partial = report.score.partial ? " · PARTIAL (missing analysis is never zero debt)" : "";
	const direction = DIRECTION_LABELS[report.score.direction] ?? report.score.direction;
	return (
		`sloppiness index ${formatNumber(report.score.index)}/100 · ` +
		`${direction} · scoring ${report.scoringVersion}${partial}`
	);
}

/** One coverage row per non-empty scope, in the contract's scope order (§3.1). */
export interface CoverageRow {
	scope: string;
	files: number;
	sloc?: number;
	note?: string;
}

/** Flatten {@link SourceCoverage} into ordered rows (absent scopes are omitted). */
export function coverageRows(coverage: SourceCoverage): CoverageRow[] {
	const rows: CoverageRow[] = [];
	for (const scope of COVERAGE_SCOPES) {
		const entry = coverage[scope];
		if (entry === undefined) continue;
		rows.push({
			scope,
			files: entry.files,
			...(entry.sloc === undefined ? {} : { sloc: entry.sloc }),
			...(entry.note === undefined ? {} : { note: entry.note }),
		});
	}
	return rows;
}

/** Display label for the audited repo: the manifest identity when declared, else the root path (§8). */
export function repoLabel(report: AuditReport): string {
	return report.repo.identity ?? report.repo.root;
}
