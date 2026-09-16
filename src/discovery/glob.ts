/**
 * Minimal POSIX-path glob matching for source classification (SPEC §3.1, §6.5).
 *
 * Supported syntax — a deliberately small, documented subset of minimatch:
 * - `*`  — any run of characters within one path segment (never crosses `/`)
 * - `?`  — exactly one character within a segment (never `/`)
 * - `**` — a whole segment matching zero or more complete segments
 *
 * Patterns match the ENTIRE repo-relative POSIX path; there is no implicit
 * prefix matching (`src/generated` does NOT match files under it — write
 * `src/generated/**`). `a/**` matches `a` itself plus every descendant, and a
 * middle `**` (pattern `a` + `**` + `b`) matches `a/b` via the zero-segment
 * case. No brace expansion, character classes, escaping, or leading `!`.
 *
 * Matching is pure and deterministic — no filesystem access.
 */

/** Compiled segment regexes, keyed by the raw segment pattern. */
const SEGMENT_CACHE = new Map<string, RegExp>();

/** Compile one non-`**` segment (`*`/`?`/literal) to an anchored regex. */
function segmentRegExp(segment: string): RegExp {
	const cached = SEGMENT_CACHE.get(segment);
	if (cached) return cached;
	const source = segment
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, "[^/]");
	const re = new RegExp(`^${source}$`);
	SEGMENT_CACHE.set(segment, re);
	return re;
}

/** Recursive segment matcher; `**` branches over how many segments it consumes. */
function matchFrom(
	pattern: readonly string[],
	pi: number,
	path: readonly string[],
	si: number,
): boolean {
	if (pi === pattern.length) return si === path.length;
	const segment = pattern[pi];
	if (segment === undefined) return si === path.length;
	if (segment === "**") {
		for (let skip = si; skip <= path.length; skip++) {
			if (matchFrom(pattern, pi + 1, path, skip)) return true;
		}
		return false;
	}
	const value = path[si];
	if (value === undefined) return false;
	return segmentRegExp(segment).test(value) && matchFrom(pattern, pi + 1, path, si + 1);
}

/**
 * True when `pattern` matches the whole repo-relative POSIX `path`.
 * See the module docblock for the supported syntax.
 */
export function matchGlob(pattern: string, path: string): boolean {
	return matchFrom(pattern.split("/"), 0, path.split("/"), 0);
}

/** True when `path` matches at least one of `patterns`. */
export function matchAnyGlob(patterns: readonly string[], path: string): boolean {
	return patterns.some((pattern) => matchGlob(pattern, path));
}
