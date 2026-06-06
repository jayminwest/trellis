/**
 * Detector layer (SPEC §8) — the deterministic HOW. Public surface: the §8.1
 * contract types + result helpers, the read-only {@link createDetectionContext},
 * and the criterion → detector {@link DetectorRegistry}. Real detectors live in
 * `common/` and the per-language adapters and bind through `registry.ts`.
 */
export {
	type CreateContextOpts,
	createDetectionContext,
	DEFAULT_TIMEOUT_MS,
	SPAWN_FAILURE_EXIT,
} from "./context.ts";
export {
	BINDINGS,
	type Binding,
	commonBinding,
	DetectorRegistry,
	languageBinding,
	REGISTRY,
} from "./registry.ts";
export {
	type DetectionContext,
	type Detector,
	type DetectorResult,
	detectorResultSchema,
	type ExecResult,
	fail,
	LANGUAGES,
	type Language,
	MAX_RATIONALE,
	NA_KINDS,
	type NaKind,
	noDetector,
	notApplicable,
	pass,
} from "./types.ts";
