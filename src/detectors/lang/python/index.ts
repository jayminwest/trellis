/**
 * Python adapter detectors (SPEC §8.3) — the Python-specific HOW.
 *
 * Each export is a {@link import("../../types.ts").Detector} keyed in `registry.ts`
 * to one criterion id via a per-language binding. They depend only on the
 * read-only {@link import("../../types.ts").DetectionContext}, mirror the §3.2
 * discipline (configured-but-unavailable → no-detector; concept present for Python
 * → pass/fail; no Python analogue → not-applicable with a rationale naming the
 * gap), and resolve tools through the target's own config (ruff / mypy / pytest /
 * coverage.py / vulture / deptry / import-linter / mutmut). Detection is
 * config-first — only `type_check` and `unit_tests_runnable` run a tool, both
 * degrading to no-detector when the toolchain is absent — so the audit needs no
 * Python on CI. This barrel re-exports the detector functions; the criterion →
 * detector wiring lives in the registry so the dependency stays one-directional.
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
	orphanModuleDetection,
	strictestTypeChecking,
} from "./locality.ts";
export { testCoverageThresholds, unitTestsRunnable } from "./testing.ts";
