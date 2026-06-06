/**
 * Shared read-only helpers for the language-agnostic detectors (SPEC §8).
 *
 * Every helper goes through the {@link DetectionContext} capabilities only —
 * no direct fs access — so detectors inherit the context's repo-containment and
 * never-throws guarantees. Glob hits are deduped and sorted for determinism
 * (identical repo → identical output, the §3.2 mandate).
 */
import type { DetectionContext } from "../types.ts";

/** All files matching any of `patterns`, deduped and sorted (deterministic). */
export async function globHits(ctx: DetectionContext, patterns: string[]): Promise<string[]> {
	const seen = new Set<string>();
	for (const pattern of patterns) {
		for (const hit of await ctx.glob(pattern)) seen.add(hit);
	}
	return [...seen].sort();
}

/** The first file matching any of `patterns` (sorted), or `null` if none match. */
export async function firstHit(ctx: DetectionContext, patterns: string[]): Promise<string | null> {
	const hits = await globHits(ctx, patterns);
	return hits[0] ?? null;
}

/** Parse a JSON file relative to the app root; `null` if absent or unparseable. */
export async function readJson(
	ctx: DetectionContext,
	rel: string,
): Promise<Record<string, unknown> | null> {
	const text = await ctx.readFile(rel);
	if (text === null) return null;
	try {
		const parsed = JSON.parse(text);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/** A discovered CI/workflow file plus its contents. */
export interface WorkflowFile {
	path: string;
	text: string;
}

/**
 * Read every CI workflow definition reachable language-agnostically: GitHub
 * Actions under `.github/workflows/`, plus a root `.gitlab-ci.yml`. Files that
 * vanish between glob and read are skipped. Sorted by path for determinism.
 */
export async function readWorkflows(ctx: DetectionContext): Promise<WorkflowFile[]> {
	const paths = await globHits(ctx, [
		".github/workflows/*.yml",
		".github/workflows/*.yaml",
		".gitlab-ci.yml",
	]);
	const files: WorkflowFile[] = [];
	for (const path of paths) {
		const text = await ctx.readFile(path);
		if (text !== null) files.push({ path, text });
	}
	return files;
}

/** True if any workflow's contents match `re` (case-insensitivity is the caller's). */
export function anyWorkflowMatches(workflows: WorkflowFile[], re: RegExp): boolean {
	return workflows.some((w) => re.test(w.text));
}

/** The `scripts` map of a parsed `package.json`, or `{}` when absent/malformed. */
export function packageScripts(pkg: Record<string, unknown> | null): Record<string, string> {
	if (pkg === null) return {};
	const scripts = pkg.scripts;
	if (typeof scripts !== "object" || scripts === null) return {};
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(scripts)) if (typeof v === "string") out[k] = v;
	return out;
}

/** The union of dependency names across the standard `package.json` dep maps. */
export function packageDeps(pkg: Record<string, unknown> | null): Set<string> {
	const names = new Set<string>();
	if (pkg === null) return names;
	for (const key of [
		"dependencies",
		"devDependencies",
		"peerDependencies",
		"optionalDependencies",
	]) {
		const map = pkg[key];
		if (typeof map === "object" && map !== null) {
			for (const name of Object.keys(map)) names.add(name);
		}
	}
	return names;
}
