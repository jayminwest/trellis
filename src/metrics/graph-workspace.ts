/**
 * Workspace-package manifest machinery for import resolution (SPEC §5.4,
 * trellis-d214) — the **pure** half: no filesystem, no resolver state.
 *
 * A bare specifier naming a workspace package resolves through that package's
 * own manifest (documented supported subset):
 *
 * - `exports` — a string (root entry only), or a map with one level of
 *   conditions tried in the order `import` → `require` → `default` →
 *   `types`; keys and targets support a single `*` wildcard (longest literal
 *   prefix wins). Arrays, nested condition objects, and non-string scalars
 *   are `unsupported-exports`. A package **with** an `exports` map
 *   encapsulates: a subpath with no matching entry fails
 *   `exports-encapsulation` — there is no fallback file probe.
 * - Without `exports`: the root resolves via `main`, then `types`, then
 *   `index`; a subpath resolves as a plain file path inside the package.
 *
 * Each candidate string is then resolved like a relative specifier from the
 * package root (see `graph-resolve.ts`), so entry points pointing at absent
 * build outputs surface as documented `unresolved` (`no-target`) edges.
 */

import type { UnresolvedReason } from "./graph-types.ts";

/** Conditions tried, in order, for one `exports` entry (documented subset). */
const EXPORTS_CONDITIONS = ["import", "require", "default", "types"] as const;

/** Match `value` against a pattern with at most one `*`; returns the matched middle or null. */
export function wildcardMatch(pattern: string, value: string): string | null {
	const star = pattern.indexOf("*");
	if (star === -1 || pattern.indexOf("*", star + 1) !== -1) return null;
	const [prefix, suffix] = [pattern.slice(0, star), pattern.slice(star + 1)];
	if (!value.startsWith(prefix) || !value.endsWith(suffix)) return null;
	return value.slice(prefix.length, value.length - suffix.length);
}

/** Extract the target string from one `exports` entry value (documented subset). */
function exportsTarget(value: unknown): { target: string } | { unsupported: true } | null {
	if (typeof value === "string") return { target: value };
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { unsupported: true };
	}
	const conditions = value as Record<string, unknown>;
	for (const condition of EXPORTS_CONDITIONS) {
		const selected = conditions[condition];
		if (typeof selected === "string") return { target: selected };
		if (selected !== undefined) return { unsupported: true };
	}
	return null;
}

/** `exportsTarget` returning null on unsupported shapes (wildcard scan helper). */
function exportsTargetOrNull(value: unknown): string | null {
	const target = exportsTarget(value);
	return target === null || "unsupported" in target ? null : target.target;
}

/** One exact `exports` entry lookup; unsupported shapes fail explicitly. */
function exactCandidate(value: unknown): { candidates: string[] } | { failure: UnresolvedReason } {
	const target = exportsTarget(value);
	return target === null || "unsupported" in target
		? { failure: "unsupported-exports" }
		: { candidates: [target.target] };
}

/** Single-`*` wildcard `exports` keys, longest literal prefix wins (documented subset). */
function wildcardCandidate(
	map: Record<string, unknown>,
	key: string,
): { candidates: string[] } | { failure: UnresolvedReason } {
	let best: { prefix: number; target: string } | null = null;
	for (const [pattern, value] of Object.entries(map)) {
		const middle = wildcardMatch(pattern, key);
		if (middle === null) continue;
		const target = exportsTargetOrNull(value);
		if (target === null) continue;
		if (best === null || pattern.indexOf("*") > best.prefix) {
			best = { prefix: pattern.indexOf("*"), target: target.replace("*", middle) };
		}
	}
	return best === null ? { failure: "exports-encapsulation" } : { candidates: [best.target] };
}

/**
 * Manifest `exports` lookup for `subpath` (`""` = the package root); returns
 * candidate target paths or a failure reason (see the module docblock).
 */
export function exportsCandidates(
	exports: unknown,
	subpath: string,
): { candidates: string[] } | { failure: UnresolvedReason } {
	const key = subpath === "" ? "." : `./${subpath}`;
	if (typeof exports === "string") {
		return key === "." ? { candidates: [exports] } : { failure: "exports-encapsulation" };
	}
	if (typeof exports !== "object" || exports === null || Array.isArray(exports)) {
		return { failure: "unsupported-exports" };
	}
	const map = exports as Record<string, unknown>;
	const exact = map[key];
	return exact !== undefined ? exactCandidate(exact) : wildcardCandidate(map, key);
}

/** Manifest fallback candidates when no `exports` map governs (`main`, then `types`, then `index`). */
export function manifestCandidates(manifest: Record<string, unknown>, subpath: string): string[] {
	if (subpath !== "") return [subpath];
	const candidates = [manifest.main, manifest.types].filter(
		(field): field is string => typeof field === "string",
	);
	return candidates.length > 0 ? candidates : ["index"];
}
