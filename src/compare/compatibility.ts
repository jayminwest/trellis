/**
 * Scored-basis compatibility (SPEC §3.5, §9, §16.6 — plan `pl-43c5` step 6,
 * trellis-bd0c).
 *
 * The **scored basis** is what the native sloppiness index and its raw
 * metrics/findings are computed from, and it is evaluated separately from
 * the advisory evidence basis (`evidence.ts`): advisory-only changes —
 * adding, removing, or upgrading an optional provider — can never make
 * two otherwise-compatible reports incompatible here (§16.6).
 *
 * Hard incompatibilities (fail closed, §9 — no score/metric/finding deltas
 * are ever silently computed):
 *
 * - `schema-version` — a side's version is not one this trellis reads
 *   (artifact loading rejects these earlier; kept as a defensive refusal),
 *   or an identity-bearing 1.2.0 report is paired with a historical schema;
 * - `analyzer-version` — the trellis releases differ;
 * - `scoring-version` — the formula versions differ, so the indices are
 *   not on one scale;
 * - `metric-set` — the **scored** metric catalogs differ. Pre-provider
 *   (1.0.0) reports read under their original interpretation (every metric
 *   is a score input); on evidence-carrying reports the catalog is
 *   the metrics owned by the declared **scored** analyses, so adding or
 *   removing an *advisory* analysis never trips this (§16.6);
 * - `configuration` — both source configurations were supplied and their
 *   `exclude`/`classify` semantics differ;
 * - `scored-measurement` — a scored analysis's **recorded** producer
 *   semantics differ (pinned tool/adapter version, mode, provider options,
 *   parser, normalized options) even when the version triple matches: the
 *   core version alone never establishes comparable measurements;
 * - `scoring-basis` — on an evidence-carrying pair the declared scored analysis sets
 *   differ, so the score's inputs are not the same set.
 *
 * Caveats (the comparison proceeds, explicitly):
 *
 * - `schema-span` — a 1.0.0 ↔ 1.1.0 pair: the pre-provider side predates
 *   the evidence area, so provider evidence is not compared on that side
 *   (it reads as unrequested), while the scored measurement body is
 *   unchanged between these additive versions and still compares;
 * - `configuration-unverifiable` — configurations were not supplied;
 * - `source-scope-changed` — the covered populations differ (normal code
 *   growth, or exclusion drift); a changed source revision is the expected
 *   input of a comparison, never a refusal.
 */
import {
	type AuditConfig,
	type AuditReport,
	carriedAnalyses,
	isSupportedSchemaVersion,
	PRE_PROVIDER_SCHEMA_VERSION,
	type SourceCoverage,
} from "../contract/index.ts";
import { type CarriedProducer, producerSemanticsDifferences } from "./evidence.ts";

/** A coded, human-readable compatibility fact about the scored basis (see the module docblock). */
export interface CompatibilityIssue {
	code:
		| "schema-version"
		| "schema-span"
		| "analyzer-version"
		| "scoring-version"
		| "metric-set"
		| "configuration"
		| "configuration-unverifiable"
		| "source-scope-changed"
		| "scored-measurement"
		| "scoring-basis";
	message: string;
}

/** Whether the scored basis of the two reports may be compared, with the explicit reasons when not. */
export interface ComparisonCompatibility {
	/** False ⇒ the scored basis differs; no score/metric/finding deltas were computed. */
	comparable: boolean;
	/** Hard scored-basis incompatibilities (empty when `comparable`). */
	issues: CompatibilityIssue[];
	/** Explicit caveats — the comparison proceeded, but a reader must know. */
	caveats: CompatibilityIssue[];
}

/** Options for {@link assessScoredBasis} and `compareReports` (compare.ts). */
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

/**
 * The scored metric catalog (§16.6): the metric ids the score is computed
 * from. Pre-provider reports read under their original interpretation —
 * every metric is a score input; evidence-carrying reports declare the
 * catalog through the scored analyses' ownership.
 */
function scoredMetricIds(report: AuditReport): string[] {
	if (report.schemaVersion === PRE_PROVIDER_SCHEMA_VERSION) {
		return Object.keys(report.metrics).sort();
	}
	const ids = carriedAnalyses(report)
		.filter((analysis) => analysis.scoring === "scored")
		.flatMap((analysis) => analysis.metricIds);
	return [...new Set(ids)].sort();
}

/** The scored analyses of one evidence-carrying report that recorded an analysis identity, keyed by provider id. */
function scoredProducers(report: AuditReport): Map<string, CarriedProducer> {
	const producers = new Map<string, CarriedProducer>();
	for (const analysis of carriedAnalyses(report)) {
		if (analysis.scoring !== "scored" || analysis.analysis === undefined) continue;
		producers.set(analysis.provider.id, {
			provider: analysis.provider,
			analysis: analysis.analysis,
		});
	}
	return producers;
}

/** The ids of every analysis a report declares as scored — the score's declared inputs (§16.5). */
function scoredAnalysisIds(report: AuditReport): string[] {
	return carriedAnalyses(report)
		.filter((analysis) => analysis.scoring === "scored")
		.map((analysis) => analysis.provider.id)
		.sort();
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
 * The version facts (§3.5): a defensive hard refusal when a side's schema
 * version is unreadable, a `schema-span` caveat for a supported 1.0.0 ↔ 1.1.0
 * pair, and hard issues for identity-schema or analyzer/scoring mismatches.
 */
function versionFacts(
	baseline: AuditReport,
	current: AuditReport,
	issues: CompatibilityIssue[],
	caveats: CompatibilityIssue[],
): void {
	// A version this trellis cannot read cannot be interpreted at all — the
	// artifact loader rejects these earlier; kept as a defensive refusal that
	// never touches the evidence area of an uninterpretable report.
	if (
		!isSupportedSchemaVersion(baseline.schemaVersion) ||
		!isSupportedSchemaVersion(current.schemaVersion)
	) {
		issues.push({
			code: "schema-version",
			message: `a report's schema version is not one this trellis reads (${baseline.schemaVersion} vs ${current.schemaVersion}): the reports cannot be interpreted under one contract`,
		});
		return;
	}
	if (baseline.schemaVersion !== current.schemaVersion) {
		if (baseline.schemaVersion === "1.2.0" || current.schemaVersion === "1.2.0") {
			issues.push({
				code: "schema-version",
				message:
					"scoped hotspot identity requires a fresh schema 1.2.0 baseline; historical schemas lack identity provenance",
			});
		} else
			caveats.push({
				code: "schema-span",
				message: `schema versions differ (${baseline.schemaVersion} vs ${current.schemaVersion}): the pre-provider side predates the evidence area, so its provider evidence reads as unrequested; the scored measurement body is unchanged between these versions`,
			});
	}
	const versionCheck = (
		code: "analyzer-version" | "scoring-version",
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
}

/** The scored-catalog fact (§16.6): the scored metric catalogs must match — advisory additions never trip it. */
function catalogIssue(baseline: AuditReport, current: AuditReport): CompatibilityIssue | null {
	const baselineCatalog = scoredMetricIds(baseline);
	const currentCatalog = scoredMetricIds(current);
	if (JSON.stringify(baselineCatalog) === JSON.stringify(currentCatalog)) return null;
	return {
		code: "metric-set",
		message: `the scored metric catalogs differ (${baselineCatalog.length} vs ${currentCatalog.length} metric ids): the two runs did not measure the same scored metric set`,
	};
}

/** The configuration facts: a hard `configuration` issue when both supplied and different, else the unverifiable caveat. */
function configurationFacts(
	options: CompareOptions,
	issues: CompatibilityIssue[],
	caveats: CompatibilityIssue[],
): void {
	if (options.baselineConfig === undefined || options.currentConfig === undefined) {
		caveats.push({
			code: "configuration-unverifiable",
			message:
				"audit configurations were not supplied: configuration compatibility could not be verified",
		});
		return;
	}
	if (!sameSourceSemantics(options.baselineConfig, options.currentConfig)) {
		issues.push({
			code: "configuration",
			message:
				"source configurations differ (exclude/classify): the audits measured different source semantics",
		});
	}
}

/**
 * Per measurement (§16.6): a scored analysis whose recorded producer
 * semantics changed is a changed scored measurement, whatever the core
 * versions say — only analyses recorded on both sides can be compared.
 */
function scoredMeasurementIssues(
	baseline: AuditReport,
	current: AuditReport,
): CompatibilityIssue[] {
	const baselineScored = scoredProducers(baseline);
	const currentScored = scoredProducers(current);
	const issues: CompatibilityIssue[] = [];
	for (const id of [...new Set([...baselineScored.keys(), ...currentScored.keys()])].sort()) {
		const before = baselineScored.get(id);
		const after = currentScored.get(id);
		if (before === undefined || after === undefined) continue;
		const differences = producerSemanticsDifferences(before, after);
		if (differences.length > 0) {
			issues.push({
				code: "scored-measurement",
				message: `scored analysis "${id}" records different measurement semantics: ${differences
					.map((difference) => difference.message)
					.join("; ")}`,
			});
		}
	}
	return issues;
}

/** The declared scored-inputs fact (evidence-carrying pairs — pre-provider reports declare none). */
function scoringBasisIssue(baseline: AuditReport, current: AuditReport): CompatibilityIssue | null {
	if (
		baseline.schemaVersion === PRE_PROVIDER_SCHEMA_VERSION ||
		current.schemaVersion === PRE_PROVIDER_SCHEMA_VERSION
	) {
		return null;
	}
	const baselineIds = scoredAnalysisIds(baseline);
	const currentIds = scoredAnalysisIds(current);
	if (JSON.stringify(baselineIds) === JSON.stringify(currentIds)) return null;
	return {
		code: "scoring-basis",
		message: `the declared scored analyses differ (${baselineIds.join(", ") || "none"} vs ${currentIds.join(", ") || "none"}): the score's inputs are not the same set`,
	};
}

/**
 * Assess the scored-basis compatibility of two validated reports (see the
 * module docblock): the hard issues that fail the comparison closed, and the
 * caveats an otherwise-proceeded comparison must carry. Pure; the evidence
 * basis is assessed independently and never consulted here.
 */
export function assessScoredBasis(
	baseline: AuditReport,
	current: AuditReport,
	options: CompareOptions = {},
): ComparisonCompatibility {
	const issues: CompatibilityIssue[] = [];
	const caveats: CompatibilityIssue[] = [];

	versionFacts(baseline, current, issues, caveats);
	if (issues.length > 0) return { comparable: false, issues, caveats };

	const catalog = catalogIssue(baseline, current);
	if (catalog !== null) issues.push(catalog);
	configurationFacts(options, issues, caveats);

	if (
		coverageFingerprint(baseline.sourceCoverage) !== coverageFingerprint(current.sourceCoverage)
	) {
		caveats.push({
			code: "source-scope-changed",
			message:
				"source coverage differs between the two reports: the compared populations are not identical",
		});
	}

	issues.push(...scoredMeasurementIssues(baseline, current));
	const scoringBasis = scoringBasisIssue(baseline, current);
	if (scoringBasis !== null) issues.push(scoringBasis);

	return { comparable: issues.length === 0, issues, caveats };
}
