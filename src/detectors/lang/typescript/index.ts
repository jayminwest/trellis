/**
 * TypeScript adapter detectors (SPEC §8.3) — the TypeScript-specific HOW.
 *
 * Each export is a {@link import("../../types.ts").Detector} keyed in
 * `registry.ts` to one criterion id via a per-language binding. They depend only
 * on the read-only {@link import("../../types.ts").DetectionContext}, mirror the
 * §3.2 discipline (configured-but-unavailable → no-detector; concept present for
 * TS → pass/fail, never not-applicable), and invoke tools through the target
 * repo's own config (Biome/tsc/knip/jscpd/bun test). This barrel re-exports the
 * detector functions; the criterion → detector wiring lives in the registry so
 * the dependency stays one-directional (registry → adapter).
 */
export {
	codeModularization,
	cyclomaticComplexity,
	deadCodeDetection,
	duplicateCodeDetection,
	formatter,
	lintConfig,
	namingConsistency,
	strictTyping,
	typeCheck,
	unusedDependenciesDetection,
} from "./code-quality.ts";
export {
	barrelFileReexportDetection,
	explicitAnyDetection,
	greppableExports,
	importCycleDetection,
	machineCheckedArchitecture,
	mutationTesting,
	orphanModuleDetection,
	strictestTypeChecking,
} from "./locality.ts";
export { errorTrackingContextualized, structuredLogging } from "./observability.ts";
export { testCoverageThresholds, unitTestsRunnable } from "./testing.ts";
