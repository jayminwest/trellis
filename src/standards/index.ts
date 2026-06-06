/** Canonical config drift core (SPEC §10): the bundled canonical set + manifest. */
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
