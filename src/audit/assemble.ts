/**
 * Report assembly (SPEC §6.4, §6.6, trellis-ef85) — the pure fold from analysis
 * results to the versioned {@link AuditReport}.
 *
 * {@link assembleReport} takes the discovery/syntax inventories, the measured
 * analyzers' results (the selected execution list — see
 * `measureAnalyses` in `audit.ts`), the safeguard inspection, and the
 * provisional sloppiness score, and produces the §6.4 report:
 *
 * - every analyzer metric is emitted exactly once (a duplicate id is a core
 *   bug and throws — the deterministic pipeline never papers it over);
 * - findings are deterministically ordered: kinds grouped lexicographically
 *   with each analyzer's internal (already deterministic) order preserved,
 *   so hotspots keep their mass rank within their kind (SPEC §3.2);
 * - source coverage pairs discovery's per-scope file counts with the
 *   measured code-line counts from the one shared parse (§3.1);
 * - `repo.identity` is the root manifest's `name` when one exists — metadata
 *   only (§8); history (trellis-424d) owns collision-resistant identity;
 * - the report carries the per-analysis evidence area (§6.6,
 *   trellis-a24d): one entry per measured analysis with its provenance,
 *   status and observed coverage, its declared scoring role, and the metric
 *   ids it owns — native measured output (values, findings) stays in the
 *   report's own areas and is never duplicated per entry. The area's
 *   completeness is the independent overall-evidence rollup; score
 *   completeness comes from the scoring input alone, so the two can never
 *   paper over each other (§16.2);
 * - the assembled report is validated against the versioned report schema
 *   before it leaves the core, so the §6.4 cross-field honesty invariants
 *   (completeness rollup, `partial` flag, traceable contributions, metric
 *   ownership, evidence status) can never be violated by a published
 *   report.
 *
 * The fold is generic over the measured results ({@link MeasuredAnalysis} —
 * the structural minimum every measured analyzer's product satisfies): since
 * the registry routing (trellis-1e66) assembly consumes whatever the selected
 * execution list produced rather than a hardcoded four-analyzer set, the
 * wrapped native runs carry the same metrics and findings the inline
 * analyzers did.
 *
 * This module does no I/O, reads no clock, and never scores: same analysis
 * results in ⇒ byte-equal report out (SPEC §3.5). Run metadata
 * (`auditedAt`, `durationMs`) is attached by the caller and is excluded
 * from the deterministic measurement payload (§6.4).
 */
import {
	ANALYZER_VERSION,
	type AnalysisResult,
	type AuditReport,
	type EvidenceArea,
	evidenceAuditReportSchema,
	type Finding,
	type MetricValue,
	type RepoMetadata,
	type ReportAnalysis,
	rollUpCompleteness,
	rollUpEvidenceCompleteness,
	SCHEMA_VERSION,
	type ScoringRole,
	type SourceCoverage,
	type SourceSet,
} from "../contract/index.ts";
import { type SourceInventory, toSourceCoverage } from "../discovery/index.ts";
import type { SafeguardInspection } from "../safeguards/index.ts";
import type { SloppinessScore } from "../scoring/index.ts";
import type { SyntaxInventory } from "../syntax/index.ts";

/**
 * One measured analysis's report contribution — the structural minimum every
 * measured analyzer's product satisfies (the native wrapped runs carry their
 * products' metrics and findings by reference, so the raw analyzer products
 * fit directly too — which the orchestration payload-equality tests rely
 * on). Order within is the producer's internal (deterministic) order; the
 * fold sorts across producers.
 */
export interface MeasuredAnalysis {
	metrics: readonly MetricValue[];
	findings: readonly Finding[];
}

/**
 * One measured analysis's evidence contribution: its product (the native
 * evidence the fold collects), its contract result (provenance, state,
 * observed coverage — internal products stripped by the producer), and the
 * registry-derived declarations the report carries: the analysis's scoring
 * role and the metric ids it owns.
 */
export interface MeasuredAnalysisEvidence extends MeasuredAnalysis {
	/** The measured contract result (§16.2): provider identity, state, analysis identity, observed coverage. */
	result: AnalysisResult;
	/** The analysis's role in the report's score — scored analyses feed the index; advisory analyses never do (§16.5). */
	scoring: ScoringRole;
	/** The metric ids this analysis owns; every id must appear in the report's metrics map. */
	metricIds: readonly string[];
}

/** The analysis results one audit assembles into its report. */
export interface AuditMeasurements {
	source: SourceInventory;
	syntax: SyntaxInventory;
	/** The measured analyzers' evidence contributions, in execution order (the selected execution list). */
	analyses: readonly MeasuredAnalysisEvidence[];
	/**
	 * The external provider analyses' contract results (§6.6, §16.5): the
	 * validated external analysis results — namespaced, advisory, unscored.
	 * Absent (or empty) for the default native audit, whose report is
	 * byte-identical to the provider-less pipeline; assembly carries each
	 * result's evidence inside its entry and never into the report's metrics
	 * map or findings list.
	 */
	providers?: readonly AnalysisResult[];
	safeguards: SafeguardInspection;
}

/** Run metadata attached to the report; never part of the measurement payload (§3.5). */
export interface AssemblyMetadata {
	/** ISO-8601 audit timestamp (from the caller's clock). */
	auditedAt?: string;
	/** Wall-clock audit duration in milliseconds. */
	durationMs?: number;
}

/** Structural minimum for metric collection (the analyzers all satisfy it). */
interface MetricSource {
	metrics: readonly MetricValue[];
}

/** Structural minimum for finding collection. */
interface FindingSource {
	findings: readonly Finding[];
}

/**
 * Collect every analyzer metric exactly once, sorted by id (the report's
 * `metrics` map is built in this order). Throws on a duplicate id — an
 * analyzer contract violation the deterministic core must never hide.
 */
export function collectMetrics(sources: readonly MetricSource[]): MetricValue[] {
	const seen = new Set<string>();
	const metrics = sources.flatMap((source) => source.metrics);
	for (const metric of metrics) {
		if (seen.has(metric.id)) {
			throw new Error(`duplicate metric id "${metric.id}" across analyzers`);
		}
		seen.add(metric.id);
	}
	return metrics.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Order findings deterministically (SPEC §3.2): grouped by kind in
 * lexicographic order, with each producer's internal order preserved within
 * its kind (a stable sort — analyzer rankings such as hotspot mass are
 * never scrambled).
 */
export function orderFindings(sources: readonly FindingSource[]): Finding[] {
	return sources
		.flatMap((source) => source.findings)
		.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}

/** Sum code-classified lines per source set from the shared parse. */
function slocBySet(syntax: SyntaxInventory): Map<SourceSet, number> {
	const sums = new Map<SourceSet, number>();
	for (const file of syntax.files) {
		sums.set(file.sourceSet, (sums.get(file.sourceSet) ?? 0) + file.lines.code);
	}
	return sums;
}

/**
 * Pair discovery's per-scope file counts with the measured code-line counts
 * (§6.4 `sourceCoverage`). Classified scopes carry `sloc`; `excluded` and
 * `unsupported` surface is counted, never parsed.
 */
export function reportCoverage(source: SourceInventory, syntax: SyntaxInventory): SourceCoverage {
	const coverage = toSourceCoverage(source);
	const sloc = slocBySet(syntax);
	const withSloc = (set: SourceSet): { sloc: number } | Record<string, never> => {
		const lines = sloc.get(set);
		return lines === undefined ? {} : { sloc: lines };
	};
	return {
		...coverage,
		production: { ...coverage.production, ...withSloc("production") },
		test: { ...coverage.test, ...withSloc("test") },
		...(coverage.generated === undefined
			? {}
			: { generated: { ...coverage.generated, ...withSloc("generated") } }),
		...(coverage.vendored === undefined
			? {}
			: { vendored: { ...coverage.vendored, ...withSloc("vendored") } }),
		...(coverage["declaration-only"] === undefined
			? {}
			: {
					"declaration-only": {
						...coverage["declaration-only"],
						...withSloc("declaration-only"),
					},
				}),
	};
}

/** Repo metadata: the absolute root plus the root manifest's `name` when declared (§8 — metadata only). */
function repoMetadata(source: SourceInventory): RepoMetadata {
	const rootPackage = source.packages.find((pkg) => pkg.path === ".");
	return {
		root: source.root,
		...(rootPackage?.name === undefined ? {} : { identity: rootPackage.name }),
	};
}

/**
 * Build one analysis's evidence-area entry: its provenance, status and
 * observed coverage plus the declared scoring role and metric ownership.
 * Native measured output (metric values, findings, clone groups) lives in
 * the report's own areas — the native entry carries only its ownership
 * ids, never a diverging copy. External evidence is namespaced and lives
 * inside its entry (§16.5, §6.6).
 */
function evidenceEntry(analysis: MeasuredAnalysisEvidence): ReportAnalysis {
	const { metrics, findings, cloneEvidence, ...provenance } = analysis.result;
	if (analysis.result.provider.kind === "native") {
		return {
			scoring: analysis.scoring,
			metricIds: [...analysis.metricIds],
			...provenance,
		};
	}
	return {
		scoring: analysis.scoring,
		metricIds: [...analysis.metricIds],
		...provenance,
		...(metrics === undefined ? {} : { metrics }),
		...(findings === undefined ? {} : { findings }),
		...(cloneEvidence === undefined ? {} : { cloneEvidence }),
	};
}

/**
 * One external provider analysis's evidence entry (§6.6): the contract
 * result as-is — advisory (never a scored input, §16.5), owning no native
 * metric ids, with its namespaced metrics, findings and clone evidence
 * carried inside the entry, never in the report's own areas.
 */
function providerEvidenceEntry(result: AnalysisResult): ReportAnalysis {
	return { scoring: "advisory", metricIds: [], ...result };
}

/**
 * Assemble the evidence area (§6.6): the measured analyses' entries plus the
 * external provider entries — unique, in provider-id order — plus the overall
 * evidence completeness rolled up from the analysis states and the native
 * metric states. Independent from score completeness by construction
 * (§16.2): the rollup never reads the score. Provider states degrade the
 * overall evidence completeness without ever flipping a complete native
 * score partial (the report contract cross-checks that split).
 */
function assembleEvidence(
	analyses: readonly MeasuredAnalysisEvidence[],
	providers: readonly AnalysisResult[],
	metrics: readonly MetricValue[],
): EvidenceArea {
	const entries = [...analyses.map(evidenceEntry), ...providers.map(providerEvidenceEntry)].sort(
		(a, b) => (a.provider.id < b.provider.id ? -1 : a.provider.id > b.provider.id ? 1 : 0),
	);
	return {
		completeness: rollUpEvidenceCompleteness(entries, metrics),
		analyses: entries,
	};
}

/**
 * Assemble and validate the §6.4 audit report (see the module docblock).
 * Pure: no I/O, no clock, no scoring — the {@link SloppinessScore} is an
 * input. Throws when the assembled report would violate the contract
 * (including the §6.4 honesty invariants and the evidence-area cross-field
 * checks), so a misleading report can never leave the core.
 */
export function assembleReport(
	measurements: AuditMeasurements,
	scoring: SloppinessScore,
	meta: AssemblyMetadata = {},
): AuditReport {
	const metrics = collectMetrics(measurements.analyses);
	const findings = orderFindings([...measurements.analyses, measurements.safeguards]);
	const run =
		meta.auditedAt === undefined && meta.durationMs === undefined
			? {}
			: {
					run: {
						...(meta.auditedAt === undefined ? {} : { auditedAt: meta.auditedAt }),
						...(meta.durationMs === undefined ? {} : { durationMs: meta.durationMs }),
					},
				};
	return evidenceAuditReportSchema.parse({
		schemaVersion: SCHEMA_VERSION,
		analyzerVersion: ANALYZER_VERSION,
		scoringVersion: scoring.scoringVersion,
		repo: repoMetadata(measurements.source),
		sourceCoverage: reportCoverage(measurements.source, measurements.syntax),
		completeness: rollUpCompleteness(metrics.map((metric) => metric.state)),
		evidence: assembleEvidence(measurements.analyses, measurements.providers ?? [], metrics),
		metrics: Object.fromEntries(metrics.map((metric) => [metric.id, metric])),
		score: scoring.score,
		findings,
		safeguards: measurements.safeguards.results,
		...run,
	});
}
