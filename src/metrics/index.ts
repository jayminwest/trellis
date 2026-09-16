/**
 * Deterministic metric analyzers over the shared syntax inventory
 * (SPEC §4 `metrics/`, §5).
 *
 * Currently: complexity & structural erosion (§5.1–5.2, trellis-fbc5) via
 * {@link analyzeComplexity}, and duplication (§5.3, trellis-6e4c) via
 * {@link analyzeDuplication}. Import cycles (trellis-d214/cbde) land as a
 * sibling analyzer over the same inventory; scoring (trellis-00d5) consumes
 * the raw metrics.
 */
export { analyzeComplexity } from "./analyze.ts";
export {
	analyzeDuplication,
	type DuplicationAnalysis,
	type DuplicationOptions,
	type DuplicationScope,
} from "./analyze-duplication.ts";
export { type FunctionComplexity, measureFunctionComplexity } from "./complexity.ts";
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
export {
	type CcDistribution,
	type ComplexityAnalysis,
	EROSION_CC_THRESHOLD,
	type FunctionMeasurement,
	type MassAggregate,
	type PackageAggregate,
	type ScopeAggregate,
} from "./types.ts";
