/**
 * Swift adapter detectors (SPEC §8.3) — the Swift-specific HOW.
 *
 * Each export is a {@link import("../../types.ts").Detector} keyed in `registry.ts`
 * to one criterion id via a per-language binding. They depend only on the
 * read-only {@link import("../../types.ts").DetectionContext}, mirror the §3.2
 * discipline (configured-but-unavailable → no-detector; concept present for Swift
 * → pass/fail; no Swift analogue → not-applicable with a rationale naming the
 * gap), and invoke tools through the target package's own config (SwiftLint /
 * `swift build` / `swift test` / swift-format / periphery / jscpd / muter). This
 * barrel re-exports the detector functions; the criterion → detector wiring lives
 * in the registry so the dependency stays one-directional (registry → adapter).
 */
export {
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
	mutationTesting,
} from "./locality.ts";
export { testCoverageThresholds, unitTestsRunnable } from "./testing.ts";
