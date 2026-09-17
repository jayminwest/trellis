/**
 * Baseline comparison of two §6.4 report artifacts (SPEC §9, trellis-942c).
 *
 * {@link compareReports} is a pure function over two already-validated
 * {@link import("../contract/index.ts").AuditReport}s — no Git, no SQLite, no
 * filesystem. Loading the artifacts themselves lives in `load.ts`; policy
 * evaluation on top of a comparison lives in `policy.ts`.
 *
 * **Compatibility (SPEC §3.5, §9).** Two reports are comparable only when
 * their measurement semantics match. The comparator refuses (`comparable:
 * false`, no deltas computed — never silently compared) when:
 *
 * - `schema-version` — the contract versions differ, so fields cannot be
 *   interpreted under one schema;
 * - `analyzer-version` — the trellis releases differ, so measurement
 *   semantics may differ;
 * - `scoring-version` — the formula versions differ, so the two indices are
 *   not on the same scale;
 * - `metric-set` — the metric id catalogs differ (different analyzers or
 *   analyzer configuration ran);
 * - `configuration` — both source configurations were supplied and their
 *   `exclude`/`classify` semantics differ (e.g. changed exclusions).
 *
 * The §6.4 report does not carry the audit configuration, so configuration
 * compatibility is only decidable when the caller supplies both configs; when
 * it does not, the comparison proceeds with an explicit
 * `configuration-unverifiable` caveat. Likewise, changed source-scope sizes
 * (coverage file/sloc counts — normal code growth, or undetected exclusion
 * drift) never refuse the comparison but are reported explicitly as a
 * `source-scope-changed` caveat.
 *
 * **Finding matching is conservative (SPEC §9).** Findings pair by `kind` +
 * `path` only. A 1:1 pair within a kind+path group is `persistent` — with
 * unlimited line-shift tolerance inside the same file, and the shift recorded
 * — while any n:m group (n ≠ m or n = m > 1) is ambiguous and reported as
 * resolved + new pairs rather than silently paired.
 */
import type {
	AnalysisState,
	AuditConfig,
	AuditReport,
	Finding,
	SourceCoverage,
} from "../contract/index.ts";

/** A coded, human-readable compatibility fact about a comparison. */
export interface CompatibilityIssue {
	/** Machine-readable code (see the module docblock). */
	code:
		| "schema-version"
		| "analyzer-version"
		| "scoring-version"
		| "metric-set"
		| "configuration"
		| "configuration-unverifiable"
		| "source-scope-changed";
	message: string;
}

/** Whether the two reports may be compared, with the explicit reasons when not. */
export interface ComparisonCompatibility {
	/** False ⇒ measurement semantics differ; no deltas were computed. */
	comparable: boolean;
	/** Hard incompatibilities (empty when `comparable`). */
	issues: CompatibilityIssue[];
	/** Explicit caveats — the comparison proceeded, but a reader must know. */
	caveats: CompatibilityIssue[];
}

/** One metric's state on one side of a comparison. */
export interface MetricSide {
	state: AnalysisState;
	/** Present exactly when the metric carries a value (§6.1 state invariants). */
	value?: number;
}

/**
 * A per-metric delta. A side is `null` when the metric is absent from that
 * report (only possible for standalone use — within a comparable
 * {@link ReportComparison} the metric sets are equal). `delta` exists only
 * when both sides carry a value.
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

/** A finding present on both sides, paired by kind + path (line shifts tolerated). */
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

/** The result of comparing two report artifacts. */
export interface ReportComparison {
	compatibility: ComparisonCompatibility;
	/** Present only when `compatibility.comparable` — never silently computed otherwise. */
	score?: ScoreDelta;
	/** Per-metric deltas over the union of metric ids, sorted by id. */
	metrics?: MetricDelta[];
	findings?: FindingComparison;
}

/** Options for {@link compareReports}. */
export interface CompareOptions {
	/**
	 * The source configurations the two audits ran with. Configuration
	 * semantics are part of comparability (§3.5) but are not carried on the
	 * §6.4 report, so they are decidable only when BOTH are supplied; then a
	 * difference in `exclude`/`classify` is a hard `configuration`
	 * incompatibility. When either is absent the comparison proceeds with a
	 * `configuration-unverifiable` caveat.
	 */
	baselineConfig?: AuditConfig;
	currentConfig?: AuditConfig;
}

function side(metric: { state: AnalysisState; value?: number } | undefined): MetricSide | null {
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

/**
 * Classify findings into new / resolved / persistent (see the module
 * docblock for the conservative matching rule).
 */
export function compareFindings(baseline: Finding[], current: Finding[]): FindingComparison {
	const groups = new Map<string, { baseline: Finding[]; current: Finding[] }>();
	const group = (kind: string, path: string) => `${kind}${path}`;
	for (const [key, list] of [
		["baseline", baseline],
		["current", current],
	] as const) {
		for (const finding of list) {
			const id = group(finding.kind, finding.path);
			const entry = groups.get(id) ?? { baseline: [], current: [] };
			entry[key].push(finding);
			groups.set(id, entry);
		}
	}
	const result: FindingComparison = { new: [], resolved: [], persistent: [] };
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

/** Per-metric deltas over the union of ids present on either report, sorted by id. */
export function compareMetrics(baseline: AuditReport, current: AuditReport): MetricDelta[] {
	const ids = [...new Set([...Object.keys(baseline.metrics), ...Object.keys(current.metrics)])];
	ids.sort();
	return ids.map((id) => {
		const before = baseline.metrics[id];
		const after = current.metrics[id];
		const delta: MetricDelta = { id, baseline: side(before), current: side(after) };
		if (before?.value !== undefined && after?.value !== undefined) {
			delta.delta = after.value - before.value;
		}
		return delta;
	});
}

/** A stable fingerprint of the scored/covered source scope (SPEC §3.1). */
function coverageFingerprint(coverage: SourceCoverage): string {
	const scopes = Object.entries(coverage)
		.map(([scope, entry]) => [scope, entry.files, entry.sloc ?? null])
		.sort(([a], [b]) => String(a).localeCompare(String(b)));
	return JSON.stringify(scopes);
}

/** Do two source configurations describe the same exclusion/classification semantics? */
function sameSourceSemantics(a: AuditConfig, b: AuditConfig): boolean {
	const excludes = (config: AuditConfig) => [...config.source.exclude].sort();
	return (
		JSON.stringify(excludes(a)) === JSON.stringify(excludes(b)) &&
		JSON.stringify(a.source.classify) === JSON.stringify(b.source.classify)
	);
}

/**
 * Compare two validated §6.4 reports (see the module docblock for the
 * compatibility and matching rules). Pure: no I/O of any kind.
 */
export function compareReports(
	baseline: AuditReport,
	current: AuditReport,
	options: CompareOptions = {},
): ReportComparison {
	const issues: CompatibilityIssue[] = [];
	const caveats: CompatibilityIssue[] = [];
	const versionCheck = (
		code: "schema-version" | "analyzer-version" | "scoring-version",
		label: string,
		before: string,
		after: string,
	): void => {
		if (before !== after) {
			issues.push({
				code,
				message: `${label} differ (${before} vs ${after}): measurement semantics are not compatible`,
			});
		}
	};
	versionCheck("schema-version", "schema versions", baseline.schemaVersion, current.schemaVersion);
	versionCheck(
		"analyzer-version",
		"analyzer versions",
		baseline.analyzerVersion,
		current.analyzerVersion,
	);
	versionCheck(
		"scoring-version",
		"scoring versions",
		baseline.scoringVersion,
		current.scoringVersion,
	);

	const baselineIds = Object.keys(baseline.metrics).sort();
	const currentIds = Object.keys(current.metrics).sort();
	if (JSON.stringify(baselineIds) !== JSON.stringify(currentIds)) {
		issues.push({
			code: "metric-set",
			message: "metric catalogs differ: the two runs did not measure the same metric set",
		});
	}

	if (options.baselineConfig !== undefined && options.currentConfig !== undefined) {
		if (!sameSourceSemantics(options.baselineConfig, options.currentConfig)) {
			issues.push({
				code: "configuration",
				message:
					"source configurations differ (exclude/classify): the audits measured different source semantics",
			});
		}
	} else {
		caveats.push({
			code: "configuration-unverifiable",
			message:
				"audit configurations were not supplied: configuration compatibility could not be verified",
		});
	}

	if (
		coverageFingerprint(baseline.sourceCoverage) !== coverageFingerprint(current.sourceCoverage)
	) {
		caveats.push({
			code: "source-scope-changed",
			message:
				"source coverage differs between the two reports: the compared populations are not identical",
		});
	}

	const compatibility: ComparisonCompatibility = {
		comparable: issues.length === 0,
		issues,
		caveats,
	};
	if (!compatibility.comparable) return { compatibility };

	return {
		compatibility,
		score: {
			baseline: baseline.score.index,
			current: current.score.index,
			delta: current.score.index - baseline.score.index,
		},
		metrics: compareMetrics(baseline, current),
		findings: compareFindings(baseline.findings, current.findings),
	};
}
