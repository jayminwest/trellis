/** Canonical config drift core (SPEC §11): the bundled canonical set + manifest. */
export {
	type AllowedDelta,
	type Divergence,
	type DivergenceKind,
	DriftError,
	type DriftOptions,
	type DriftReport,
	driftRepo,
	type FileDrift,
	resolveCanonicalVersion,
} from "./drift.ts";
export { renderDriftMarkdown, renderDriftTerminal } from "./drift-report.ts";
export {
	DRIFT_STATES,
	type DriftState,
	FAILING_DRIFT_STATES,
	failingDriftCount,
	hasFailingDrift,
} from "./drift-states.ts";
export {
	CANONICAL_DIR,
	CANONICAL_SUFFIX,
	canonicalStoragePath,
	type HashMismatch,
	hashContent,
	loadManifest,
	MANIFEST_FILE,
	MATCHER_KINDS,
	type Manifest,
	ManifestError,
	type ManifestFile,
	type MatcherKind,
	manifestFileSchema,
	manifestSchema,
	readCanonical,
	verifyManifest,
} from "./manifest.ts";
