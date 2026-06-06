/**
 * Canonical standards manifest (SPEC §10).
 *
 * trellis bundles a versioned set of shared tooling files under
 * {@link CANONICAL_DIR} (`src/standards/canonical/`), described by
 * `src/standards/manifest.yaml`. The manifest carries, per file: the path it
 * occupies in a target repo, the semver of that file's canonical form, a
 * `sha256:` digest of its exact bytes on disk, and the {@link MatcherKind} the
 * drift engine (SPEC §10, `drift.ts`) uses to compare a target against it.
 *
 * The digest makes the canonical set **byte-tracked**: {@link verifyManifest}
 * recomputes every hash from disk, so any unrecorded edit to a bundled file —
 * or a stale manifest entry — fails the test suite (and therefore CI). The
 * canonical files live inside trellis as the single source of truth, versioned
 * in lockstep with the tool.
 *
 * This module is the WHAT/HOW seam's data layer: the schema + loader + hashing
 * helpers. The matchers themselves live in `drift.ts` (next step).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";

/** Directory holding the bundled canonical files, relative to this module. */
export const CANONICAL_DIR = "canonical";

/**
 * On-disk suffix every bundled file carries under {@link CANONICAL_DIR}. The
 * canonical bytes are stored as `<path>.canon` so that no tool auto-discovers
 * them as live config (a `canonical/biome.json` would otherwise be loaded by
 * Biome as a nested root config and break the build). The suffix is a storage
 * detail: the manifest `path` and the recorded hash describe the unsuffixed
 * target file, and {@link readCanonical} resolves the storage location.
 */
export const CANONICAL_SUFFIX = ".canon";

/** Manifest filename, relative to this module's directory. */
export const MANIFEST_FILE = "manifest.yaml";

/**
 * How the drift engine compares a target file against its canonical form:
 *   - `exact` — byte-for-byte identity (fixed scripts/hooks).
 *   - `json-subset` — canonical keys must be present & equal; extra keys allowed.
 *   - `yaml-subset` — same, for YAML documents.
 *   - `text` — whitespace/line-ending–normalized text equality.
 *   - `template` — section/structure-aware (e.g. AGENTS.md headings), not bytes.
 */
export const MATCHER_KINDS = ["exact", "json-subset", "yaml-subset", "text", "template"] as const;
export type MatcherKind = (typeof MATCHER_KINDS)[number];

/** Strict semver `MAJOR.MINOR.PATCH` (no pre-release/build metadata). */
const semver = z.string().regex(/^\d+\.\d+\.\d+$/, "must be semver MAJOR.MINOR.PATCH");

/** `sha256:` + 64 lowercase hex chars — the form {@link hashContent} emits. */
const sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/, "must be 'sha256:' + 64 hex chars");

/**
 * Relative POSIX path of a canonical file, as it appears in a target repo
 * (e.g. `biome.json`, `.github/workflows/ci.yml`). No leading slash, no `..`,
 * no backslashes — the path also locates the file under {@link CANONICAL_DIR}.
 */
const relPath = z
	.string()
	.min(1)
	.refine((p) => !p.startsWith("/") && !p.includes("\\") && !p.split("/").includes(".."), {
		message: "must be a relative POSIX path without '..' segments",
	});

/** One canonical file's manifest entry (SPEC §10). */
export const manifestFileSchema = z.strictObject({
	path: relPath,
	version: semver,
	hash: sha256Digest,
	matcher: z.enum(MATCHER_KINDS),
});

export type ManifestFile = z.infer<typeof manifestFileSchema>;

/** The canonical set as a whole: a set-level semver plus its files. */
export const manifestSchema = z.strictObject({
	version: semver,
	files: z.array(manifestFileSchema).min(1),
});

export type Manifest = z.infer<typeof manifestSchema>;

/** A manifest load/verification failure, naming the offending file path. */
export class ManifestError extends Error {
	override readonly name = "ManifestError";
	readonly path: string;

	constructor(message: string, path: string) {
		super(path ? `${MANIFEST_FILE} [${path}]: ${message}` : `${MANIFEST_FILE}: ${message}`);
		this.path = path;
	}
}

/** Compute the canonical `sha256:`-prefixed digest of a file's exact bytes. */
export function hashContent(bytes: Uint8Array | string): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Absolute on-disk location of the bundled bytes for a canonical `path`,
 * under `canonicalDir` (defaults to {@link CANONICAL_DIR} beside this module).
 * Applies the {@link CANONICAL_SUFFIX} storage convention.
 */
export function canonicalStoragePath(
	path: string,
	canonicalDir: string = join(import.meta.dir, CANONICAL_DIR),
): string {
	return join(canonicalDir, `${path}${CANONICAL_SUFFIX}`);
}

/**
 * Read the bundled canonical bytes for a manifest `path`. Throws if the file is
 * absent — callers that tolerate missing files should catch.
 */
export function readCanonical(path: string, canonicalDir?: string): Buffer {
	return readFileSync(canonicalStoragePath(path, canonicalDir));
}

/**
 * Load and validate the manifest from `dir` (defaults to this module's
 * directory). Enforces the schema and that paths are unique. Throws
 * {@link ManifestError} on any violation.
 */
export function loadManifest(dir: string = import.meta.dir): Manifest {
	let raw: unknown;
	try {
		raw = yaml.load(readFileSync(join(dir, MANIFEST_FILE), "utf8"));
	} catch {
		throw new ManifestError("source file not found or unreadable", "");
	}

	const result = manifestSchema.safeParse(raw);
	if (!result.success) {
		const issue = result.error.issues[0];
		const where = issue?.path.join(".") || "<root>";
		throw new ManifestError(issue?.message ?? "schema validation failed", where);
	}

	const seen = new Set<string>();
	for (const file of result.data.files) {
		if (seen.has(file.path)) {
			throw new ManifestError("duplicate file path", file.path);
		}
		seen.add(file.path);
	}

	return result.data;
}

/** A single hash disagreement between the manifest and the file on disk. */
export interface HashMismatch {
	path: string;
	/** The digest recorded in the manifest. */
	expected: string;
	/** The digest recomputed from disk, or `null` if the file is missing. */
	actual: string | null;
}

/**
 * Recompute every canonical file's digest from disk under `canonicalDir`
 * (defaults to {@link CANONICAL_DIR} beside this module) and return the entries
 * whose recorded hash disagrees — empty when the manifest is in sync. A missing
 * file reports `actual: null`. This is the byte-tracking check the manifest test
 * (and thus CI) runs to fail on undeclared drift.
 */
export function verifyManifest(manifest: Manifest, canonicalDir?: string): HashMismatch[] {
	const mismatches: HashMismatch[] = [];
	for (const file of manifest.files) {
		let actual: string | null;
		try {
			actual = hashContent(readCanonical(file.path, canonicalDir));
		} catch {
			actual = null;
		}
		if (actual !== file.hash) {
			mismatches.push({ path: file.path, expected: file.hash, actual });
		}
	}
	return mismatches;
}
