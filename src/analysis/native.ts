/**
 * Wrapped native analyzers and the audited native registry (SPEC §16, plan
 * `pl-43c5` step 3 — trellis-cb51).
 *
 * Each wrapper calls **one existing analyzer unchanged** — same algorithm,
 * same thresholds, same source-set boundaries, same finding order (AC1) —
 * and returns the complete native product plus its step-2 typed contract
 * result: provider identity, analysis identity, observed coverage, metrics,
 * findings, and — where they exist — the typed internal products
 * (`products.graph`, `products.clones`) downstream analyzers consume in
 * process. ASTs and internal caches never serialize as evidence (AC2); use
 * `toContractResult` for the report-shaped minimum.
 *
 * The declared seam (AC2): `trellis.import-cycles` declares
 * `trellis.dependency-graph` as its prerequisite, and the cycle wrapper
 * consumes the graph wrapper's *run* — product, selection, and coverage — so
 * the dependency is typed, not re-derived.
 *
 * Safeguard separation (AC3, §3.2/§5.5): the safeguard inspection is
 * registered (addressable by id) but declares **no metrics** — it produces a
 * configuration-evidence panel that can never enter the scored measurement
 * set (`requiredForScoring` cannot derive it), and its run carries no
 * measured analysis result: the §16.2 analysis identity selects *source*
 * files, which a configuration inspection over non-source surfaces honestly
 * cannot claim.
 *
 * The registry is built from explicit registrations below — no arbitrary
 * module loading. Audit orchestration (trellis-1e66) consumes these runs;
 * this step does not wire them into the audit.
 */

import { compareCloneLocations } from "../contract/clone-evidence.ts";
import type {
	AnalysisIdentity,
	CloneEvidence,
	ObservedCoverage,
	ProviderIdentity,
} from "../contract/index.ts";
import type { SourceInventory } from "../discovery/index.ts";
import { DUPLICATION_LIMITS } from "../metrics/duplication-work.ts";
import {
	analyzeComplexity,
	analyzeCycles,
	analyzeDependencyGraph,
	analyzeDuplication,
	type CloneGroup,
	type ComplexityAnalysis,
	type CycleAnalysis,
	DEFAULT_DUPLICATION_BUDGET,
	type DependencyGraphAnalysis,
	type DuplicationAnalysis,
	type DuplicationOptions,
} from "../metrics/index.ts";
import { inspectSafeguards, type SafeguardInspection } from "../safeguards/index.ts";
import type { SyntaxInventory } from "../syntax/index.ts";
import {
	ALL_SOURCE_SETS,
	MEASURED_SOURCE_SETS,
	type NativeScope,
	nativeAnalysisIdentity,
	nativeAnalyzerIdentity,
	nativeScope,
} from "./provenance.ts";
import {
	buildNativeRegistry,
	type NativeAnalyzerRegistration,
	type NativeRegistry,
	requiredForScoring,
} from "./registry.ts";
import type { InternalAnalysisResult } from "./result.ts";

const DUPLICATION_NATIVE_OPTIONS = { engine: "suffix-array-lcp", "work-accounting": "v2" } as const;

/** Supported native analyzer ids, sorted (the registry's addressable surface). */
export const NATIVE_ANALYZER_IDS = [
	"trellis.complexity",
	"trellis.dependency-graph",
	"trellis.duplication",
	"trellis.import-cycles",
	"trellis.safeguards",
] as const;

/** One native analyzer id. */
export type NativeAnalyzerId = (typeof NATIVE_ANALYZER_IDS)[number];

/** A measured native run's contract result: provenance and coverage always present. */
export interface MeasuredAnalysisResult extends InternalAnalysisResult {
	provider: ProviderIdentity;
	state: "complete" | "incomplete";
	analysis: AnalysisIdentity;
	observedCoverage: ObservedCoverage;
	reason?: string;
}

/** One wrapped analyzer run: the unchanged native product plus its contract result. */
export interface NativeAnalysisRun<TProduct> {
	/** The complete native analysis product — deep-equal to the unwrapped analyzer's output (AC1). */
	product: TProduct;
	/** The measured contract result, with internal products attached (AC2). */
	result: MeasuredAnalysisResult;
}

/** One wrapped non-scoring inspection run: the product, no measured analysis (AC3). */
export interface NativeInspectionRun<TProduct> {
	product: TProduct;
}

/** Fold a scope's outcome into the shared result fields (state, coverage, reason). */
function scopeFields(scope: NativeScope) {
	const { outcome } = scope;
	return {
		state: outcome.state,
		observedCoverage: outcome.observedCoverage,
		...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
	};
}

/**
 * Wrap {@link analyzeComplexity} unchanged: complexity & structural erosion
 * over the shared parse, measured production/test sets, in their original
 * order.
 */
export function runComplexityAnalysis(
	syntax: SyntaxInventory,
): NativeAnalysisRun<ComplexityAnalysis> {
	const product = analyzeComplexity(syntax);
	const scope = nativeScope(syntax, MEASURED_SOURCE_SETS);
	return {
		product,
		result: {
			provider: nativeAnalyzerIdentity("trellis.complexity", "shared-parse"),
			...scopeFields(scope),
			analysis: nativeAnalysisIdentity(scope, syntax.compilerVersion),
			metrics: product.metrics,
			findings: product.findings,
		},
	};
}

/** Map the native detector's clone groups to contract group evidence (the serialized view). */
function cloneGroupEvidence(groups: readonly CloneGroup[]): CloneEvidence[] {
	return groups.map((group) => ({
		kind: "group" as const,
		matchMode: "normalized" as const,
		members: group.members
			.map((member) => ({ path: member.path, range: member.range }))
			.sort(compareCloneLocations),
	}));
}

/**
 * Wrap {@link analyzeDuplication} unchanged: normalized-token clone
 * detection per measured source set under the supplied (or default)
 * resource budget, with groups in their original order. The budget is
 * recorded as trellis-owned declarative options in the analysis identity.
 */
export function runDuplicationAnalysis(
	syntax: SyntaxInventory,
	options: DuplicationOptions = {},
): NativeAnalysisRun<DuplicationAnalysis> {
	const product = analyzeDuplication(syntax, options);
	const scope = nativeScope(syntax, MEASURED_SOURCE_SETS);
	const budget = options.budget ?? DEFAULT_DUPLICATION_BUDGET;
	return {
		product,
		result: {
			provider: nativeAnalyzerIdentity(
				"trellis.duplication",
				"shared-parse",
				DUPLICATION_NATIVE_OPTIONS,
			),
			...scopeFields(scope),
			analysis: nativeAnalysisIdentity(scope, syntax.compilerVersion, {
				"max-tokens": budget.maxTokens,
				"max-match-work": budget.maxMatchWork,
				"work-accounting": "v2",
				"max-streams": DUPLICATION_LIMITS.maxStreams,
				"max-working-cells": DUPLICATION_LIMITS.maxWorkingCells,
				"max-groups": DUPLICATION_LIMITS.maxGroups,
				"max-occurrences": DUPLICATION_LIMITS.maxOccurrences,
			}),
			metrics: product.metrics,
			findings: product.findings,
			cloneEvidence: cloneGroupEvidence([
				...product.scopes.production.groups,
				...product.scopes.test.groups,
			]),
			products: {
				clones: {
					groups: [...product.scopes.production.groups, ...product.scopes.test.groups],
				},
			},
		},
	};
}

/**
 * Wrap {@link analyzeDependencyGraph} unchanged: import resolution over the
 * shared parse, every classified file (all source sets) in its original
 * order. The graph is exposed as the typed internal product (AC2) for the
 * cycle wrapper and downstream consumers.
 */
export function runDependencyGraphAnalysis(
	source: SourceInventory,
	syntax: SyntaxInventory,
): NativeAnalysisRun<DependencyGraphAnalysis> {
	const product = analyzeDependencyGraph(source, syntax);
	const scope = nativeScope(syntax, ALL_SOURCE_SETS);
	return {
		product,
		result: {
			provider: nativeAnalyzerIdentity("trellis.dependency-graph", "shared-parse"),
			...scopeFields(scope),
			analysis: nativeAnalysisIdentity(scope, syntax.compilerVersion),
			metrics: product.metrics,
			findings: product.findings,
			products: {
				graph: { nodes: product.graph.nodes, edges: product.graph.edges },
			},
		},
	};
}

/**
 * Wrap {@link analyzeCycles} unchanged: complete cyclic groups over the
 * resolved dependency graph, in their original order. Consumes the graph
 * wrapper's run (the declared prerequisite) and records exactly the inputs
 * that run carried — the same selection, coverage, and degradation state the
 * graph observed.
 */
export function runImportCycleAnalysis(
	graph: NativeAnalysisRun<DependencyGraphAnalysis>,
): NativeAnalysisRun<CycleAnalysis> {
	const product = analyzeCycles(graph.product);
	return {
		product,
		result: {
			provider: nativeAnalyzerIdentity("trellis.import-cycles", "graph"),
			state: graph.result.state,
			analysis: graph.result.analysis,
			observedCoverage: graph.result.observedCoverage,
			...(graph.result.reason === undefined ? {} : { reason: graph.result.reason }),
			metrics: product.metrics,
			findings: product.findings,
		},
	};
}

/**
 * Wrap {@link inspectSafeguards} unchanged: the non-scoring configuration
 * panel (§5.5) — results in fixed id order plus broken-reference findings.
 * Carries no measured analysis result (see the module docblock, AC3).
 */
export async function runSafeguardInspection(
	root: string,
): Promise<NativeInspectionRun<SafeguardInspection>> {
	return { product: await inspectSafeguards(root) };
}

/** The complexity analyzer's metric ids (mirrors `analyzeComplexity` output, sorted). */
const COMPLEXITY_METRICS = [
	"complexity.cc.max.production",
	"complexity.cc.max.test",
	"complexity.cc.p50.production",
	"complexity.cc.p50.test",
	"complexity.cc.p90.production",
	"complexity.cc.p90.test",
	"complexity.functions.production",
	"complexity.functions.test",
	"complexity.nesting.max.production",
	"complexity.nesting.max.test",
	"erosion.eroded-count.production",
	"erosion.eroded-count.test",
	"erosion.eroded-share.production",
	"erosion.eroded-share.test",
	"erosion.mass.production",
	"erosion.mass.test",
] as const;

/** The duplication analyzer's metric ids (mirrors `analyzeDuplication` output, sorted). */
const DUPLICATION_METRICS = [
	"duplication.density.production",
	"duplication.density.test",
	"duplication.duplicated-lines.production",
	"duplication.duplicated-lines.test",
	"duplication.groups.production",
	"duplication.groups.test",
] as const;

/** The dependency-graph analyzer's metric ids (mirrors its output, sorted). */
const GRAPH_METRICS = [
	"graph.edges.external",
	"graph.edges.local",
	"graph.edges.unresolved",
	"graph.files",
] as const;

/** The import-cycle analyzer's metric ids (mirrors its output, sorted). */
const CYCLE_METRICS = [
	"import-cycle.density",
	"import-cycle.groups",
	"import-cycle.modules",
] as const;

const complexityAnalyzer: NativeAnalyzerRegistration = {
	identity: nativeAnalyzerIdentity("trellis.complexity", "shared-parse"),
	capabilities: ["complexity"],
	metrics: COMPLEXITY_METRICS,
	requires: [],
};

const duplicationAnalyzer: NativeAnalyzerRegistration = {
	identity: nativeAnalyzerIdentity(
		"trellis.duplication",
		"shared-parse",
		DUPLICATION_NATIVE_OPTIONS,
	),
	capabilities: ["duplication"],
	metrics: DUPLICATION_METRICS,
	requires: [],
};

const dependencyGraphAnalyzer: NativeAnalyzerRegistration = {
	identity: nativeAnalyzerIdentity("trellis.dependency-graph", "shared-parse"),
	capabilities: ["dependency-graph"],
	metrics: GRAPH_METRICS,
	requires: [],
};

const importCyclesAnalyzer: NativeAnalyzerRegistration = {
	identity: nativeAnalyzerIdentity("trellis.import-cycles", "graph"),
	capabilities: ["import-cycles"],
	metrics: CYCLE_METRICS,
	requires: ["trellis.dependency-graph"],
};

const safeguardsAnalyzer: NativeAnalyzerRegistration = {
	identity: nativeAnalyzerIdentity("trellis.safeguards", "configuration-inspection"),
	capabilities: ["safeguards"],
	metrics: [],
	requires: [],
};

/** The audited native registry: every supported analyzer, validated at load. */
export const NATIVE_REGISTRY: NativeRegistry = buildNativeRegistry([
	complexityAnalyzer,
	duplicationAnalyzer,
	dependencyGraphAnalyzer,
	importCyclesAnalyzer,
	safeguardsAnalyzer,
]);

/**
 * The native analyses the current scoring catalog requires (AC3): owners of
 * catalog metric ids plus transitive prerequisites. The safeguard inspection
 * is never among them.
 */
export function nativeScoringRequiredIds(): string[] {
	return requiredForScoring(NATIVE_REGISTRY);
}
