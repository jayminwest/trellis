/**
 * Shared validation primitives for the §6 versioned contracts (SPEC §6).
 *
 * Kept dependency-free so every contract module composes the same notions of
 * identifier, repo-relative path, and version string instead of drifting into
 * per-module regexes.
 */
import { z } from "zod";

/**
 * Dotted identifier: lowercase segments joined by `.`, each segment starting
 * with a letter and allowing digits and hyphens (`duplication.density`,
 * `complexity.hotspot`, `import-cycle`, `pre-commit-hook`).
 */
export const dottedIdSchema = z
	.string()
	.regex(
		/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/,
		"must be a dotted identifier (lowercase segments joined by '.')",
	);

/**
 * Repo-relative POSIX path (`src/report/build.ts`). Rejects absolute paths,
 * Windows drive paths, backslashes, empty segments, and `..` traversal so a
 * finding can never point outside the audited root.
 */
export function isRepoRelativePath(path: string): boolean {
	if (path.length === 0 || path.startsWith("/") || path.includes("\\")) return false;
	if (/^[A-Za-z]:/.test(path)) return false;
	return path.split("/").every((segment) => segment.length > 0 && segment !== "..");
}

export const relativePathSchema = z
	.string()
	.min(1)
	.refine(isRepoRelativePath, "must be a repo-relative POSIX path");

/**
 * Semantic version with an optional prerelease suffix (`1.0.0`,
 * `0.1.0-provisional`). All three contract versions (analyzer, scoring,
 * schema — SPEC §3.5) validate against this shape.
 */
export const versionStringSchema = z
	.string()
	.regex(
		/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
		"must be a semantic version (X.Y.Z with optional prerelease suffix)",
	);

/** Finite number — rejects `Infinity`/`NaN` so a measurement can never smuggle in a non-value. */
export const finiteNumberSchema = z.number().finite();
