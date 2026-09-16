/**
 * Deterministic metric analyzers over the shared syntax inventory
 * (SPEC §4 `metrics/`, §5).
 *
 * Currently: complexity & structural erosion (§5.1–5.2, trellis-fbc5) via
 * {@link analyzeComplexity}, duplication (§5.3, trellis-6e4c) via
 * {@link analyzeDuplication}, the workspace-aware dependency graph (§5.4,
 * trellis-d214) via {@link analyzeDependencyGraph}, and import-cycle
 * measurement (§5.4, trellis-cbde) via {@link analyzeCycles} over that
 * graph. Scoring (trellis-00d5) consumes the raw metrics.
 */
export { analyzeComplexity } from "./analyze.ts";
export {
	analyzeCycles,
	type CycleAnalysis,
	type CycleGroup,
	type PackageCycleView,
} from "./analyze-cycles.ts";
export {
	analyzeDuplication,
	type DuplicationAnalysis,
	type DuplicationOptions,
	type DuplicationScope,
} from "./analyze-duplication.ts";
export { analyzeDependencyGraph } from "./analyze-graph.ts";
export { type FunctionComplexity, measureFunctionComplexity } from "./complexity.ts";
export {
	buildAdjacency,
	CYCLE_POLICY,
	CYCLE_POLICY_VERSION,
	type CyclePolicy,
	compareStrings,
	detectClassGroups,
	type EdgeClass,
	type RawCycleGroup,
	representativeCycle,
	stronglyConnectedComponents,
} from "./cycles.ts";
export {
	type BudgetExhaustion,
	type CloneDetection,
	type CloneGroup,
	type CloneMember,
	collectTokenStream,
	DEFAULT_DUPLICATION_BUDGET,
	DUPLICATION_MIN_LINES,
	DUPLICATION_MIN_TOKENS,
	type DuplicationBudget,
	type TokenStream,
} from "./duplication.ts";
export { detectClones } from "./duplication-detect.ts";
export {
	aggregateMass,
	ccDistribution,
	functionMass,
	isEroded,
	type MassContribution,
	nearestRank,
	packageAggregate,
	roundTo,
} from "./erosion.ts";
export { collectImportSites, type ImportSite } from "./graph-imports.ts";
export { createGraphResolver, type GraphResolver } from "./graph-resolve.ts";
export {
	type DependencyGraph,
	type DependencyGraphAnalysis,
	type EdgeKind,
	type EdgeResolution,
	type ExternalPackage,
	GRAPH_POLICY,
	GRAPH_POLICY_VERSION,
	type GraphConfig,
	type GraphEdge,
	type GraphNode,
	type GraphPolicy,
	type UnresolvedReason,
} from "./graph-types.ts";
export {
	type CcDistribution,
	type ComplexityAnalysis,
	EROSION_CC_THRESHOLD,
	type FunctionMeasurement,
	type MassAggregate,
	type PackageAggregate,
	type ScopeAggregate,
} from "./types.ts";
