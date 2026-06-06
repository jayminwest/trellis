/** Canonical config drift core (SPEC §10): the bundled canonical set + manifest. */
export {
	type AllowedDelta,
	type Divergence,
	type DivergenceKind,
	DRIFT_STATES,
	DriftError,
	type DriftOptions,
	type DriftReport,
	type DriftState,
	driftRepo,
	FAILING_DRIFT_STATES,
	type FileDrift,
	resolveCanonicalVersion,
} from "./drift.ts";
export { renderDriftMarkdown, renderDriftTerminal } from "./drift-report.ts";
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
