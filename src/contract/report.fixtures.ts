/**
 * Shared fixtures for the versioned §6.4 report contract (trellis-a24d).
 *
 * Typed literals (compile-checked against the contract types, mirroring
 * `analysis-result.fixtures.ts`) for a minimal valid evidence-carrying
 * report: one complete native analysis over an empty production selection
 * (an honest empty measurement — complete over exactly the zero files it
 * selected, §16.2) that owns the report's metric ids. Store and history
 * tests use these to build minimal but valid schema-1.1.0 reports; the
 * report contract tests build their variants on top.
 */
import type { AnalysisIdentity } from "./analysis.ts";
import type { EvidenceArea, ReportAnalysis, ScoringRole } from "./evidence.ts";
import type { ProviderIdentity } from "./provider.ts";
import { ANALYZER_VERSION } from "./version.ts";

/** The native analyzer identity the fixture entries carry. */
export const fixtureNativeProvider: ProviderIdentity = {
	kind: "native",
	id: "trellis.complexity",
	toolVersion: ANALYZER_VERSION,
	adapterVersion: ANALYZER_VERSION,
	mode: "shared-parse",
	options: {},
};

/** A complete native analysis identity over an empty production selection. */
export const fixtureNativeAnalysisIdentity: AnalysisIdentity = {
	selection: { sourceSets: ["production"], files: [] },
	parser: { engine: "trellis.typescript", version: "5.9.3" },
	options: {},
};

/** A complete native analysis entry owning `metricIds` (scored by default). */
export function fixtureNativeAnalysis(
	metricIds: readonly string[],
	scoring: ScoringRole = "scored",
): ReportAnalysis {
	return {
		scoring,
		metricIds: [...metricIds],
		provider: fixtureNativeProvider,
		state: "complete",
		analysis: fixtureNativeAnalysisIdentity,
		observedCoverage: {
			analyzedFiles: [],
			diagnostics: [],
			unsupported: [],
		},
	};
}

/**
 * A minimal complete evidence area: one scored native analysis owning
 * `metricIds`. The area's completeness is complete (the analysis is
 * complete and the owning tests keep their metrics complete).
 */
export function fixtureEvidenceArea(metricIds: readonly string[]): EvidenceArea {
	return {
		completeness: "complete",
		analyses: [fixtureNativeAnalysis(metricIds)],
	};
}
