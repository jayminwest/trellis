/**
 * Shared read-only helpers for the TypeScript adapter detectors (SPEC §8.3).
 *
 * Like the common helpers, everything routes through the {@link DetectionContext}
 * capabilities — no direct fs — so the adapter inherits repo-containment and the
 * never-throws guarantee. The TypeScript-specific surface adds three things the
 * language-agnostic layer doesn't need: a JSONC-tolerant reader (tsconfig/biome
 * configs routinely carry comments + trailing commas), a bounded `extends`-merge
 * for `tsconfig.json` (flags often live in a base config), and a Biome-rule
 * lookup that treats a rule as "enabled" only when it is not `"off"`.
 */
import type { DetectionContext } from "../../types.ts";

/** Strip `//` and block comments + trailing commas, then `JSON.parse`. `null` on failure. */
export function parseJsonc(text: string): Record<string, unknown> | null {
	// Remove block comments, then line comments, then trailing commas. Conservative:
	// good enough for config files, never executed against arbitrary source.
	const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, "");
	const noLine = noBlock.replace(/(^|[^:"'])\/\/[^\n\r]*/g, "$1");
	const noTrailingComma = noLine.replace(/,(\s*[}\]])/g, "$1");
	try {
		const parsed = JSON.parse(noTrailingComma);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/** Read + JSONC-parse a file relative to the app root; `null` if absent or unparseable. */
export async function readJsonc(
	ctx: DetectionContext,
	rel: string,
): Promise<Record<string, unknown> | null> {
	const text = await ctx.readFile(rel);
	return text === null ? null : parseJsonc(text);
}

/** A located Biome config and its parsed contents. */
export interface BiomeConfig {
	path: string;
	config: Record<string, unknown>;
}

/** Find and parse the repo's Biome config (`biome.json` / `biome.jsonc`), if any. */
export async function findBiomeConfig(ctx: DetectionContext): Promise<BiomeConfig | null> {
	for (const rel of ["biome.json", "biome.jsonc"]) {
		const config = await readJsonc(ctx, rel);
		if (config !== null) return { path: rel, config };
	}
	return null;
}

/** The first ESLint config path present (flat or legacy), or `null`. */
export async function findEslintConfig(ctx: DetectionContext): Promise<string | null> {
	for (const rel of [
		"eslint.config.js",
		"eslint.config.mjs",
		"eslint.config.cjs",
		"eslint.config.ts",
		".eslintrc.js",
		".eslintrc.cjs",
		".eslintrc.json",
		".eslintrc.yml",
		".eslintrc.yaml",
		".eslintrc",
	]) {
		if ((await ctx.readFile(rel)) !== null) return rel;
	}
	return null;
}

/**
 * A `tsconfig.json` resolved through a bounded `extends` chain. `compilerOptions`
 * is the merged map (base flags overridden by the child). `extendsUnresolved` is
 * true when an `extends` target could not be read (e.g. a preset package we can't
 * resolve) — callers map that ambiguity to `no-detector` rather than a false fail.
 */
export interface ResolvedTsConfig {
	path: string;
	compilerOptions: Record<string, unknown>;
	extendsUnresolved: boolean;
}

/** Candidate paths an `extends` string can point at (relative file, or a package's tsconfig). */
function extendsCandidates(spec: string): string[] {
	const out: string[] = [];
	if (spec.startsWith(".")) {
		out.push(spec, spec.endsWith(".json") ? spec : `${spec}.json`);
	} else {
		out.push(
			`node_modules/${spec}`,
			`node_modules/${spec}.json`,
			`node_modules/${spec}/tsconfig.json`,
		);
	}
	return [...new Set(out)];
}

/**
 * Load `tsconfig.json` (or `rel`) and merge its `extends` chain (base→child),
 * bounded to {@link MAX_EXTENDS_DEPTH} hops to stay deterministic and cheap.
 */
const MAX_EXTENDS_DEPTH = 5;

/** Read the first resolvable `extends` candidate for `spec`, or `null` if none resolve. */
async function readExtends(
	ctx: DetectionContext,
	spec: string,
): Promise<Record<string, unknown> | null> {
	for (const cand of extendsCandidates(spec)) {
		const next = await readJsonc(ctx, cand);
		if (next !== null) return next;
	}
	return null;
}

export async function loadTsConfig(
	ctx: DetectionContext,
	rel = "tsconfig.json",
): Promise<ResolvedTsConfig | null> {
	const root = await readJsonc(ctx, rel);
	if (root === null) return null;
	let extendsUnresolved = false;
	let current: Record<string, unknown> | null = root;
	// Walk up the extends chain, collecting configs base-last.
	const chain: Record<string, unknown>[] = [];
	for (let depth = 0; current !== null && depth < MAX_EXTENDS_DEPTH; depth += 1) {
		chain.unshift(current);
		const ext = current.extends;
		if (typeof ext !== "string") break;
		const next = await readExtends(ctx, ext);
		if (next === null) {
			extendsUnresolved = true;
			break;
		}
		current = next;
	}
	let merged: Record<string, unknown> = {};
	for (const cfg of chain) {
		const co = cfg.compilerOptions;
		if (typeof co === "object" && co !== null) {
			merged = { ...merged, ...(co as Record<string, unknown>) };
		}
	}
	return { path: rel, compilerOptions: merged, extendsUnresolved };
}

/** A compiler flag read as a strict boolean (anything non-`true` is `false`). */
export function flag(co: Record<string, unknown>, name: string): boolean {
	return co[name] === true;
}

/**
 * Read a Biome linter rule's level by group + name, e.g. `("suspicious",
 * "noExplicitAny")`. Returns the level string (`"error"`/`"warn"`/`"info"`/
 * `"off"`) or `null` when the rule isn't explicitly configured. A rule given as
 * an object (`{ level, options }`) reports its `level`.
 */
export function biomeRuleLevel(
	config: Record<string, unknown>,
	group: string,
	rule: string,
): string | null {
	const linter = config.linter;
	if (typeof linter !== "object" || linter === null) return null;
	const rules = (linter as Record<string, unknown>).rules;
	if (typeof rules !== "object" || rules === null) return null;
	const grp = (rules as Record<string, unknown>)[group];
	if (typeof grp !== "object" || grp === null) return null;
	const entry = (grp as Record<string, unknown>)[rule];
	if (typeof entry === "string") return entry;
	if (typeof entry === "object" && entry !== null) {
		const level = (entry as Record<string, unknown>).level;
		return typeof level === "string" ? level : null;
	}
	return null;
}

/** True when the Biome linter is configured and not disabled. */
export function biomeLinterEnabled(config: Record<string, unknown>): boolean {
	const linter = config.linter;
	if (typeof linter !== "object" || linter === null) return false;
	return (linter as Record<string, unknown>).enabled !== false;
}

/** True when Biome's `recommended` ruleset is on (default-on unless set false). */
export function biomeRecommended(config: Record<string, unknown>): boolean {
	const linter = config.linter;
	if (typeof linter !== "object" || linter === null) return false;
	const rules = (linter as Record<string, unknown>).rules;
	if (typeof rules !== "object" || rules === null) return false;
	return (rules as Record<string, unknown>).recommended !== false;
}

/** Source roots searched for `.ts`/`.tsx` files, in glob form, excluding vendored/build dirs. */
const SOURCE_GLOBS = ["**/*.ts", "**/*.tsx"] as const;
const EXCLUDE_RE = /(^|\/)(node_modules|dist|build|out|coverage|\.git|__golden__|vendor)(\/|$)/;

/** Cap on source files scanned by grep/graph detectors — keeps the audit bounded. */
export const MAX_SOURCE_FILES = 4000;

/** Repo-relative `.ts`/`.tsx` sources (excluding vendored/build dirs and `.d.ts`), capped + sorted. */
export async function tsSources(ctx: DetectionContext): Promise<string[]> {
	const seen = new Set<string>();
	for (const pattern of SOURCE_GLOBS) {
		for (const hit of await ctx.glob(pattern)) {
			if (EXCLUDE_RE.test(hit) || hit.endsWith(".d.ts")) continue;
			seen.add(hit);
		}
	}
	return [...seen].sort().slice(0, MAX_SOURCE_FILES);
}

/** True if any of `names` appears in the union of `package.json` dependency maps. */
export function depsHasAny(deps: Set<string>, names: readonly string[]): boolean {
	return names.some((n) => deps.has(n));
}

/** True if any `package.json` script's name or command matches `re`. */
export function scriptMatches(scripts: Record<string, string>, re: RegExp): boolean {
	return Object.entries(scripts).some(([k, v]) => re.test(k) || re.test(v));
}
