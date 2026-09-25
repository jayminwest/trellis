/**
 * Workspace-package manifest machinery for import resolution (SPEC §5.4,
 * trellis-d214) — the **pure** half: no filesystem, no resolver state.
 *
 * A bare specifier naming a workspace package resolves through that package's
 * own manifest (documented supported subset):
 *
 * - `exports` — a string (root entry only), or a map whose entries are
 *   strings, fallback arrays, or condition objects (nested up to
 *   {@link MAX_CONDITION_DEPTH} levels). Conditions are tried in the order:
 *   the governing tsconfig's `customConditions`, then source-named
 *   conditions (`source`, `@scope/source`, sorted), then `source` →
 *   `import` → `require` → `default` → `types`. Every matching target is returned in
 *   that priority order so the resolver can fall through to the next one
 *   when an entry points at absent build output (graph policy 1.1.0,
 *   trellis-a98b). Keys and targets support a single `*` wildcard (longest
 *   literal prefix wins). An entry yielding no target (only unknown
 *   conditions, non-string scalars, or deeper nesting) is
 *   `unsupported-exports`. A package **with** an `exports` map
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

/** Built-in conditions tried, in order, after any tsconfig `customConditions`. */
const EXPORTS_CONDITIONS = ["source", "import", "require", "default", "types"] as const;

/** Condition objects/arrays nest at most this deep (documented subset). */
const MAX_CONDITION_DEPTH = 4;

/** Match `value` against a pattern with at most one `*`; returns the matched middle or null. */
export function wildcardMatch(pattern: string, value: string): string | null {
	const star = pattern.indexOf("*");
	if (star === -1 || pattern.indexOf("*", star + 1) !== -1) return null;
	const [prefix, suffix] = [pattern.slice(0, star), pattern.slice(star + 1)];
	if (!value.startsWith(prefix) || !value.endsWith(suffix)) return null;
	return value.slice(prefix.length, value.length - suffix.length);
}

/** True for a condition that names source by convention: `source`, `@scope/source`, `x:source`. */
function isSourceCondition(condition: string): boolean {
	return /(^|[/:])source$/.test(condition);
}

/** Source-named conditions used anywhere in an `exports` value, sorted (deterministic). */
function sourceConditions(value: unknown, depth = 0): string[] {
	if (depth > MAX_CONDITION_DEPTH || typeof value !== "object" || value === null) return [];
	const entries = Array.isArray(value)
		? value.map((item) => ["", item] as const)
		: Object.entries(value);
	const found = new Set<string>();
	for (const [key, item] of entries) {
		if (isSourceCondition(key)) found.add(key);
		for (const nested of sourceConditions(item, depth + 1)) found.add(nested);
	}
	return [...found].sort();
}

/** Collect every target of one `exports` entry value, in condition priority order. */
function collectTargets(
	value: unknown,
	conditions: readonly string[],
	depth: number,
	into: string[],
): void {
	if (typeof value === "string") {
		if (!into.includes(value)) into.push(value);
		return;
	}
	if (depth >= MAX_CONDITION_DEPTH || typeof value !== "object" || value === null) return;
	if (Array.isArray(value)) {
		for (const item of value) collectTargets(item, conditions, depth + 1, into);
		return;
	}
	const map = value as Record<string, unknown>;
	for (const condition of conditions) {
		if (condition in map) collectTargets(map[condition], conditions, depth + 1, into);
	}
}

/** The targets of one `exports` entry value; empty when the shape yields none. */
function exportsTargets(value: unknown, conditions: readonly string[]): string[] {
	const targets: string[] = [];
	collectTargets(value, conditions, 0, targets);
	return targets;
}

/** One exact `exports` entry lookup; shapes yielding no target fail explicitly. */
function exactCandidate(
	value: unknown,
	conditions: readonly string[],
): { candidates: string[] } | { failure: UnresolvedReason } {
	const targets = exportsTargets(value, conditions);
	return targets.length === 0 ? { failure: "unsupported-exports" } : { candidates: targets };
}

/** Single-`*` wildcard `exports` keys, longest literal prefix wins (documented subset). */
function wildcardCandidate(
	map: Record<string, unknown>,
	key: string,
	conditions: readonly string[],
): { candidates: string[] } | { failure: UnresolvedReason } {
	let best: { prefix: number; targets: string[] } | null = null;
	for (const [pattern, value] of Object.entries(map)) {
		const middle = wildcardMatch(pattern, key);
		if (middle === null) continue;
		const targets = exportsTargets(value, conditions);
		if (targets.length === 0) continue;
		if (best === null || pattern.indexOf("*") > best.prefix) {
			best = {
				prefix: pattern.indexOf("*"),
				targets: targets.map((target) => target.replace("*", middle)),
			};
		}
	}
	return best === null ? { failure: "exports-encapsulation" } : { candidates: best.targets };
}

/**
 * Manifest `exports` lookup for `subpath` (`""` = the package root); returns
 * candidate target paths in priority order or a failure reason (see the
 * module docblock). `customConditions` come from the importer's governing
 * tsconfig and outrank the built-in conditions.
 */
export function exportsCandidates(
	exports: unknown,
	subpath: string,
	customConditions: readonly string[] = [],
): { candidates: string[] } | { failure: UnresolvedReason } {
	const key = subpath === "" ? "." : `./${subpath}`;
	if (typeof exports === "string") {
		return key === "." ? { candidates: [exports] } : { failure: "exports-encapsulation" };
	}
	if (typeof exports !== "object" || exports === null) {
		return { failure: "unsupported-exports" };
	}
	const conditions = [
		...new Set([...customConditions, ...sourceConditions(exports), ...EXPORTS_CONDITIONS]),
	];
	if (Array.isArray(exports) || !Object.keys(exports).some((entry) => entry.startsWith("."))) {
		// Sugar: a root-only fallback array or condition object.
		return key === "." ? exactCandidate(exports, conditions) : { failure: "exports-encapsulation" };
	}
	const map = exports as Record<string, unknown>;
	const exact = map[key];
	return exact !== undefined
		? exactCandidate(exact, conditions)
		: wildcardCandidate(map, key, conditions);
}

/** Manifest fallback candidates when no `exports` map governs (`main`, then `types`, then `index`). */
export function manifestCandidates(manifest: Record<string, unknown>, subpath: string): string[] {
	if (subpath !== "") return [subpath];
	const candidates = [manifest.main, manifest.types].filter(
		(field): field is string => typeof field === "string",
	);
	return candidates.length > 0 ? candidates : ["index"];
}
