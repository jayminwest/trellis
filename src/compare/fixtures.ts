/**
 * Shared builders for the `src/compare/` tests (trellis-bd0c): minimal but
 * **valid** reports — every builder output is parsed through the §6.4
 * `auditReportSchema`, so a fixture can never drift from the contract's
 * honesty invariants (metric ownership, score/evidence completeness, the
 * §16.2 state matrix). Two report families cover the versioned artifact
 * pairs: evidence-carrying (schema 1.1.0) reports with native and external
 * analysis entries, and pre-provider (schema 1.0.0) reports that predate
 * the evidence area and keep their original interpretation.
 */
import {
	ANALYZER_VERSION,
	type AnalysisIdentity,
	type AuditReport,
	auditReportSchema,
	type Finding,
	type MetricValue,
	type ObservedCoverage,
	PRE_PROVIDER_SCHEMA_VERSION,
	type ProviderIdentity,
	type ProviderOptions,
	type ProviderState,
	type ReportAnalysis,
	rollUpCompleteness,
	rollUpEvidenceCompleteness,
	rollUpScoreCompleteness,
	SCHEMA_VERSION,
	SCORING_VERSION,
	type ScoringRole,
	type SourceSet,
} from "../contract/index.ts";

const fingerprint = (seed: string): string => seed.repeat(64);

/** A complete count metric. */
export function completeMetric(id: string, value = 1): MetricValue {
	return { id, state: "complete", value, unit: "count" };
}

/** What one analysis builder overrides (defaults per builder; §16.2 state matrix enforced by the schema). */
export interface AnalysisOverrides {
	state?: ProviderState;
	scoring?: ScoringRole;
	/** The provider id (the native builder's second analyzer identity). */
	id?: string;
	/** The native metric ids the entry owns (native entries only). */
	metricIds?: string[];
	/** The pinned tool version (also the default parser version). */
	toolVersion?: string;
	providerOptions?: ProviderOptions;
	parser?: { engine: string; version: string };
	analysisOptions?: ProviderOptions;
	/** The selected file paths; fingerprints derive from `fingerprintSeed`. */
	paths?: string[];
	fingerprintSeed?: string;
	sourceSets?: SourceSet[];
	metrics?: MetricValue[];
	findings?: Finding[];
	/** The located reason for a gap state. */
	reason?: string;
}

function selection(paths: readonly string[], seed: string, sourceSets: readonly SourceSet[]) {
	return {
		sourceSets: [...sourceSets],
		files: paths.map((path) => ({ path, fingerprint: fingerprint(seed) })),
	};
}

/** The observed coverage a complete analysis asserts: exactly its selection, no diagnostics (§16.2). */
function completeCoverage(
	paths: readonly string[],
	sourceSets: readonly SourceSet[],
): ObservedCoverage {
	return {
		analyzedFiles: [...paths],
		analyzedLines: paths.length * 100,
		bySourceSet: { [sourceSets[0] ?? "production"]: paths.length },
		diagnostics: [],
		unsupported: [],
	};
}

/** The partial coverage an incomplete analysis asserts: the last file unanalyzed, with a diagnostic. */
function partialCoverage(
	paths: readonly string[],
	sourceSets: readonly SourceSet[],
): ObservedCoverage {
	const analyzed = paths.slice(0, Math.max(paths.length - 1, 0));
	const rest = paths.slice(Math.max(paths.length - 1, 0));
	return {
		analyzedFiles: analyzed,
		analyzedLines: analyzed.length * 100,
		bySourceSet: { [sourceSets[0] ?? "production"]: analyzed.length },
		diagnostics: rest.map((path) => ({ path, message: "typescript parser unavailable" })),
		unsupported: [],
	};
}

/** The analysis identity shared by the entry builders (selection from the overrides, parser per builder). */
function analysisIdentity(
	parser: { engine: string; version: string },
	options: ProviderOptions,
	overrides: AnalysisOverrides,
): AnalysisIdentity {
	return {
		selection: selection(
			overrides.paths ?? ["src/a.ts"],
			overrides.fingerprintSeed ?? "a",
			overrides.sourceSets ?? ["production"],
		),
		parser: overrides.parser ?? parser,
		options: overrides.analysisOptions ?? options,
	};
}

/** Shape one entry against the §16.2 state matrix (the schema re-checks every rule). */
function entry(
	provider: ProviderIdentity,
	defaultParser: { engine: string; version: string },
	defaultOptions: ProviderOptions,
	metricIds: readonly string[],
	defaultScoring: ScoringRole,
	overrides: AnalysisOverrides,
): ReportAnalysis {
	const state = overrides.state ?? "complete";
	const base: ReportAnalysis = {
		provider,
		state,
		scoring: overrides.scoring ?? defaultScoring,
		metricIds: [...(overrides.metricIds ?? metricIds)],
	};
	if (state === "unrequested") return base;
	if (state === "unavailable" || state === "unsupported") {
		return { ...base, reason: overrides.reason ?? "the pinned tool is not installed" };
	}
	const paths = overrides.paths ?? ["src/a.ts"];
	const sourceSets = overrides.sourceSets ?? ["production"];
	return {
		...base,
		analysis: analysisIdentity(defaultParser, defaultOptions, overrides),
		observedCoverage:
			state === "complete"
				? completeCoverage(paths, sourceSets)
				: partialCoverage(paths, sourceSets),
		...(state === "incomplete"
			? { reason: overrides.reason ?? "one file could not be parsed" }
			: {}),
		...(overrides.metrics ? { metrics: overrides.metrics } : {}),
		...(overrides.findings ? { findings: overrides.findings } : {}),
	};
}

/** The default scored native entry: `trellis.complexity` owning `complexity.average-cc` over one file. */
export function nativeComplexityAnalysis(overrides: AnalysisOverrides = {}): ReportAnalysis {
	return entry(
		{
			kind: "native",
			id: overrides.id ?? "trellis.complexity",
			toolVersion: overrides.toolVersion ?? ANALYZER_VERSION,
			adapterVersion: ANALYZER_VERSION,
			mode: "shared-parse",
			options: overrides.providerOptions ?? {},
		},
		{ engine: "trellis.typescript", version: "5.9.3" },
		{},
		["complexity.average-cc"],
		"scored",
		overrides,
	);
}

/** The default advisory external entry: pinned jscpd 5.2.1 in token mode over one file. */
export function jscpdAnalysis(overrides: AnalysisOverrides = {}): ReportAnalysis {
	return entry(
		{
			kind: "external",
			id: "jscpd",
			toolVersion: overrides.toolVersion ?? "5.2.1",
			adapterVersion: "0.2.1",
			mode: "token",
			options: overrides.providerOptions ?? { "ignore-identifiers": true },
		},
		{ engine: "jscpd.tokenizer", version: overrides.toolVersion ?? "5.2.1" },
		{ "min-tokens": 50 },
		[],
		"advisory",
		{
			metrics: [completeMetric("provider.jscpd.pairs")],
			findings: [
				{
					kind: "provider.jscpd.clone-pair",
					path: "src/a.ts",
					range: { start: { line: 3 }, end: { line: 17 } },
					summary: "normalized clone pair with src/b.ts:5",
				},
			],
			...overrides,
		},
	);
}

/** Optional report-level knobs for the report builders. */
export interface ReportSpec {
	schemaVersion?: "1.1.0" | "1.2.0";
	/** Merged over the default metrics (one complete metric per native-owned id). */
	metrics?: Record<string, MetricValue>;
	/** The headline index (default 10). */
	index?: number;
	findings?: Finding[];
	analyzerVersion?: string;
	scoringVersion?: string;
}

/** A minimal valid evidence-carrying (1.1.0) report carrying `analyses` (sorted into evidence-area order). */
export function evidenceReport(
	analyses: readonly ReportAnalysis[],
	spec: ReportSpec = {},
): AuditReport {
	const metrics: Record<string, MetricValue> = {};
	for (const analysis of analyses) {
		if (analysis.provider.kind !== "native") continue;
		for (const id of analysis.metricIds) metrics[id] = completeMetric(id);
	}
	Object.assign(metrics, spec.metrics ?? {});
	const scoredIds = [
		...new Set(
			analyses
				.filter((analysis) => analysis.scoring === "scored" && analysis.provider.kind === "native")
				.flatMap((analysis) => analysis.metricIds),
		),
	].sort();
	const index = spec.index ?? 10;
	return auditReportSchema.parse({
		schemaVersion: spec.schemaVersion ?? SCHEMA_VERSION,
		analyzerVersion: spec.analyzerVersion ?? ANALYZER_VERSION,
		scoringVersion: spec.scoringVersion ?? SCORING_VERSION,
		repo: { root: "/abs/path" },
		sourceCoverage: { production: { files: 2, sloc: 200 }, test: { files: 1, sloc: 50 } },
		completeness: rollUpCompleteness(Object.values(metrics).map((metric) => metric.state)),
		metrics,
		score: {
			index,
			direction: "lower-is-better",
			partial: rollUpScoreCompleteness(analyses, metrics) === "incomplete",
			contributions:
				scoredIds.length > 0
					? [{ dimension: "test.dimension", points: index, metricIds: scoredIds }]
					: [],
		},
		findings: spec.findings ?? [],
		safeguards: [],
		evidence: {
			completeness: rollUpEvidenceCompleteness(analyses, Object.values(metrics)),
			analyses: [...analyses].sort((a, b) => a.provider.id.localeCompare(b.provider.id)),
		},
	});
}

/** A minimal valid pre-provider (1.0.0) report over `metrics` — every metric a score input, no evidence area. */
export function preProviderReport(
	metrics: Record<string, MetricValue> = {
		"complexity.average-cc": completeMetric("complexity.average-cc"),
	},
	spec: ReportSpec = {},
): AuditReport {
	const index = spec.index ?? 10;
	const completeness = rollUpCompleteness(Object.values(metrics).map((metric) => metric.state));
	return auditReportSchema.parse({
		schemaVersion: PRE_PROVIDER_SCHEMA_VERSION,
		analyzerVersion: spec.analyzerVersion ?? ANALYZER_VERSION,
		scoringVersion: spec.scoringVersion ?? SCORING_VERSION,
		repo: { root: "/abs/path" },
		sourceCoverage: { production: { files: 2, sloc: 200 }, test: { files: 1, sloc: 50 } },
		completeness,
		metrics,
		score: {
			index,
			direction: "lower-is-better",
			partial: completeness === "incomplete",
			contributions: [
				{ dimension: "test.dimension", points: index, metricIds: Object.keys(metrics).sort() },
			],
		},
		findings: spec.findings ?? [],
		safeguards: [],
	});
}
