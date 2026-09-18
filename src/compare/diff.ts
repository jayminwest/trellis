/**
 * Pure metric and finding diffs (SPEC §9, trellis-942c; per-basis split,
 * trellis-bd0c) — the value-level half of a report comparison. Shared by the
 * scored-basis report diff ({@link ./compare.ts}) and the per-provider
 * evidence diff ({@link ./evidence.ts}), so both always classify and order
 * identically.
 *
 * **Finding matching is conservative (SPEC §9).** Modern native hotspots
 * pair only on unique compatible scoped identities; explicit ambiguity never
 * falls back to kind+path. Historical hotspots and other kinds keep the
 * kind+path 1:1 fallback. Any n:m key group remains resolved + new, preserving
 * multiplicity. Persistent pairs retain unlimited line-shift tolerance.
 *
 * Pure functions over already-validated contract values — no I/O of any kind.
 */
import { HOTSPOT_IDENTITY_VERSION } from "../contract/hotspot-identity.ts";
import type { AnalysisState, AuditReport, Finding, MetricValue } from "../contract/index.ts";

/** One metric's state on one side of a comparison. */
export interface MetricSide {
	state: AnalysisState;
	/** Present exactly when the metric carries a value (§6.1 state invariants). */
	value?: number;
}

/**
 * A per-metric delta. A side is `null` when the metric is absent from that
 * report — possible within a comparable comparison when an advisory analysis
 * was added or removed (its metrics are not score inputs), and for
 * standalone use over arbitrary pairs. `delta` exists only when both sides
 * carry a value.
 */
export interface MetricDelta {
	id: string;
	baseline: MetricSide | null;
	current: MetricSide | null;
	/** `current.value - baseline.value`; positive means more of the measured debt. */
	delta?: number;
}

/** The headline-index delta (lower is better; positive `delta` is a regression). */
export interface ScoreDelta {
	baseline: number;
	current: number;
	delta: number;
}

/** A finding present on both sides, paired by its kind-specific identity (line shifts tolerated). */
export interface PersistentFinding {
	baseline: Finding;
	current: Finding;
	/** `current.range.start.line - baseline.range.start.line`. */
	lineShift: number;
}

/** The conservative three-way finding classification (SPEC §9). */
export interface FindingComparison {
	new: Finding[];
	resolved: Finding[];
	persistent: PersistentFinding[];
}

export function metricSide(
	metric: { state: AnalysisState; value?: number } | undefined,
): MetricSide | null {
	if (metric === undefined) return null;
	const result: MetricSide = { state: metric.state };
	if (metric.value !== undefined) result.value = metric.value;
	return result;
}

/** Deterministic finding order: kind, then path, then start line. */
function byLocation(a: Finding, b: Finding): number {
	return (
		a.kind.localeCompare(b.kind) ||
		a.path.localeCompare(b.path) ||
		a.range.start.line - b.range.start.line
	);
}

/** A structured scoped key, historical fallback key, or explicit non-matchability. */
function findingKey(finding: Finding): string | null {
	const identity = finding.identity;
	if (finding.kind !== "complexity.hotspot" || identity === undefined) {
		return `${finding.kind}${finding.path}`;
	}
	if (identity.version !== HOTSPOT_IDENTITY_VERSION || identity.state !== "identified") return null;
	const component = identity.function;
	return JSON.stringify([
		identity.version,
		finding.kind,
		finding.path,
		identity.sourceSet,
		identity.scopes.map(({ kind, name, member }) => [kind, name, member]),
		[component.kind, component.name, component.member],
	]);
}

/** Partition by identity while preserving every explicitly ambiguous occurrence. */
function groupFindings(baseline: Finding[], current: Finding[], result: FindingComparison) {
	const groups = new Map<string, { baseline: Finding[]; current: Finding[] }>();
	for (const [key, list] of [
		["baseline", baseline],
		["current", current],
	] as const) {
		for (const finding of list) {
			const id = findingKey(finding);
			if (id === null) {
				result[key === "baseline" ? "resolved" : "new"].push(finding);
				continue;
			}
			const entry = groups.get(id) ?? { baseline: [], current: [] };
			entry[key].push(finding);
			groups.set(id, entry);
		}
	}
	return groups;
}

/** Classify with one-to-one pairing only; ambiguous groups never lose multiplicity. */
export function compareFindings(baseline: Finding[], current: Finding[]): FindingComparison {
	const result: FindingComparison = { new: [], resolved: [], persistent: [] };
	const groups = groupFindings(baseline, current, result);
	for (const { baseline: before, current: after } of groups.values()) {
		if (before.length === 1 && after.length === 1) {
			const [b] = before;
			const [c] = after;
			if (b !== undefined && c !== undefined) {
				result.persistent.push({
					baseline: b,
					current: c,
					lineShift: c.range.start.line - b.range.start.line,
				});
			}
			continue;
		}
		// Ambiguous (n:m) groups are never silently paired (SPEC §9).
		result.resolved.push(...before);
		result.new.push(...after);
	}
	result.new.sort(byLocation);
	result.resolved.sort(byLocation);
	result.persistent.sort((a, b) => byLocation(a.current, b.current));
	return result;
}

/** Per-metric deltas over the union of ids in two metric records, sorted by id. */
export function compareMetricRecords(
	baseline: Readonly<Record<string, MetricValue>>,
	current: Readonly<Record<string, MetricValue>>,
): MetricDelta[] {
	const ids = [...new Set([...Object.keys(baseline), ...Object.keys(current)])];
	ids.sort();
	return ids.map((id) => {
		const before = baseline[id];
		const after = current[id];
		const delta: MetricDelta = {
			id,
			baseline: metricSide(before),
			current: metricSide(after),
		};
		if (before?.value !== undefined && after?.value !== undefined) {
			delta.delta = after.value - before.value;
		}
		return delta;
	});
}

/** Per-metric deltas over the union of ids carried by two metric lists, sorted by id. */
export function compareMetricValues(
	baseline: readonly MetricValue[],
	current: readonly MetricValue[],
): MetricDelta[] {
	const record = (metrics: readonly MetricValue[]): Record<string, MetricValue> =>
		Object.fromEntries(metrics.map((metric) => [metric.id, metric]));
	return compareMetricRecords(record(baseline), record(current));
}

/** Per-metric deltas over the union of metric ids on either report, sorted by id. */
export function compareMetrics(baseline: AuditReport, current: AuditReport): MetricDelta[] {
	return compareMetricRecords(baseline.metrics, current.metrics);
}
