/**
 * Report assembly (SPEC §6.4, trellis-ef85) — the pure fold from analysis
 * products to the versioned {@link AuditReport}.
 *
 * {@link assembleReport} takes the discovery/syntax inventories, the four
 * metric-analyzer outputs, the safeguard inspection, and the provisional
 * sloppiness score, and produces the §6.4 report:
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
 * - the assembled report is validated against `auditReportSchema` before it
 *   leaves the core, so the §6.4 cross-field honesty invariants
 *   (completeness rollup, `partial` flag, traceable contributions) can never
 *   be violated by a published report.
 *
 * This module does no I/O, reads no clock, and never scores: same analysis
 * products in ⇒ byte-equal report out (SPEC §3.5). Run metadata
 * (`auditedAt`, `durationMs`) is attached by the caller and is excluded
 * from the deterministic measurement payload (§6.4).
 */
import {
	ANALYZER_VERSION,
	type AuditReport,
	auditReportSchema,
	type Finding,
	type MetricValue,
	type RepoMetadata,
	rollUpCompleteness,
	SCHEMA_VERSION,
	type SourceCoverage,
	type SourceSet,
} from "../contract/index.ts";
import { type SourceInventory, toSourceCoverage } from "../discovery/index.ts";
import type {
	ComplexityAnalysis,
	CycleAnalysis,
	DependencyGraphAnalysis,
	DuplicationAnalysis,
} from "../metrics/index.ts";
import type { SafeguardInspection } from "../safeguards/index.ts";
import type { SloppinessScore } from "../scoring/index.ts";
import type { SyntaxInventory } from "../syntax/index.ts";

/** The analysis products one audit assembles into its report. */
export interface AuditMeasurements {
	source: SourceInventory;
	syntax: SyntaxInventory;
	complexity: ComplexityAnalysis;
	duplication: DuplicationAnalysis;
	graph: DependencyGraphAnalysis;
	cycles: CycleAnalysis;
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
 * Assemble and validate the §6.4 audit report (see the module docblock).
 * Pure: no I/O, no clock, no scoring — the {@link SloppinessScore} is an
 * input. Throws when the assembled report would violate the contract
 * (including the §6.4 honesty invariants), so a misleading report can never
 * leave the core.
 */
export function assembleReport(
	measurements: AuditMeasurements,
	scoring: SloppinessScore,
	meta: AssemblyMetadata = {},
): AuditReport {
	const metrics = collectMetrics([
		measurements.complexity,
		measurements.duplication,
		measurements.graph,
		measurements.cycles,
	]);
	const findings = orderFindings([
		measurements.complexity,
		measurements.duplication,
		measurements.graph,
		measurements.cycles,
		measurements.safeguards,
	]);
	const run =
		meta.auditedAt === undefined && meta.durationMs === undefined
			? {}
			: {
					run: {
						...(meta.auditedAt === undefined ? {} : { auditedAt: meta.auditedAt }),
						...(meta.durationMs === undefined ? {} : { durationMs: meta.durationMs }),
					},
				};
	return auditReportSchema.parse({
		schemaVersion: SCHEMA_VERSION,
		analyzerVersion: ANALYZER_VERSION,
		scoringVersion: scoring.scoringVersion,
		repo: repoMetadata(measurements.source),
		sourceCoverage: reportCoverage(measurements.source, measurements.syntax),
		completeness: rollUpCompleteness(metrics.map((metric) => metric.state)),
		metrics: Object.fromEntries(metrics.map((metric) => [metric.id, metric])),
		score: scoring.score,
		findings,
		safeguards: measurements.safeguards.results,
		...run,
	});
}
