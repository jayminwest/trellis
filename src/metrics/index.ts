/**
 * Deterministic metric analyzers over the shared syntax inventory
 * (SPEC §4 `metrics/`, §5).
 *
 * Currently: complexity & structural erosion (§5.1–5.2, trellis-fbc5) via
 * {@link analyzeComplexity}. Duplication (trellis-5a91/6e4c) and import
 * cycles (trellis-d214/cbde) land as sibling analyzers over the same
 * inventory; scoring (trellis-00d5) consumes the raw metrics.
 */
export { analyzeComplexity } from "./analyze.ts";
export { type FunctionComplexity, measureFunctionComplexity } from "./complexity.ts";
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
