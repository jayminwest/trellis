/**
 * Shared read-only helpers for the Swift adapter detectors (SPEC §8.3).
 *
 * Like the other adapters everything routes through the {@link DetectionContext}
 * capabilities — no direct fs — so the adapter inherits repo-containment and the
 * never-throws guarantee. Swift's tooling lives in config files and build glue
 * rather than a single manifest's dependency list, so the Swift-specific surface
 * adds three things: a SwiftLint-config reader (YAML with `disabled_rules` /
 * `opt_in_rules` / `only_rules` semantics), a "is this default rule active"
 * predicate, and a {@link gatherToolingText} sweep that concatenates the places a
 * Swift repo wires a tool (Package.swift, Makefile, Mintfile/Brewfile, CI
 * workflows, `scripts/`) so config-first detectors can grep for a tool by name.
 */
import yaml from "js-yaml";
import { readWorkflows } from "../../common/util.ts";
import type { DetectionContext } from "../../types.ts";

/** The SwiftPM package manifest filename — discovery tags an app `swift` on its presence. */
export const MANIFEST = "Package.swift";

/** Read the SwiftPM manifest text, or `null` when there is no `Package.swift`. */
export async function readManifest(ctx: DetectionContext): Promise<string | null> {
	return ctx.readFile(MANIFEST);
}

/** The first present file among `rels` (in order), or `null` if none exist. */
export async function firstPresent(
	ctx: DetectionContext,
	rels: readonly string[],
): Promise<string | null> {
	for (const rel of rels) {
		if ((await ctx.readFile(rel)) !== null) return rel;
	}
	return null;
}

/** A located SwiftLint config and its parsed contents. */
export interface SwiftlintConfig {
	path: string;
	config: Record<string, unknown>;
}

/** Candidate SwiftLint config filenames (`.swiftlint.yml` / `.swiftlint.yaml`). */
const SWIFTLINT_CONFIGS = [".swiftlint.yml", ".swiftlint.yaml"] as const;

/** Parse YAML into a plain object; `null` on failure or a non-object document. */
function parseYaml(text: string): Record<string, unknown> | null {
	try {
		const doc = yaml.load(text);
		return typeof doc === "object" && doc !== null && !Array.isArray(doc)
			? (doc as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/**
 * Find and parse the repo's SwiftLint config. An empty-but-present config parses
 * to `{}` (SwiftLint still applies its default rules), so callers distinguish
 * "no config" (`null`) from "config with defaults" (`{}`).
 */
export async function findSwiftlintConfig(ctx: DetectionContext): Promise<SwiftlintConfig | null> {
	for (const rel of SWIFTLINT_CONFIGS) {
		const text = await ctx.readFile(rel);
		if (text === null) continue;
		return { path: rel, config: parseYaml(text) ?? {} };
	}
	return null;
}

/** Read a config key as an array of rule-id strings (`disabled_rules`, etc.). */
function ruleList(config: Record<string, unknown>, key: string): string[] {
	const value = config[key];
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * True when a SwiftLint **default** rule (one active out of the box, e.g.
 * `identifier_name`, `cyclomatic_complexity`) is in force for this config: not
 * listed in `disabled_rules`, and — when an `only_rules` allowlist is present —
 * explicitly included in it.
 */
export function swiftlintDefaultRuleEnabled(
	config: Record<string, unknown>,
	rule: string,
): boolean {
	const only = ruleList(config, "only_rules");
	if (only.length > 0) return only.includes(rule);
	return !ruleList(config, "disabled_rules").includes(rule);
}

/** Filenames whose presence/contents reveal which Swift tools a repo wires up. */
const TOOLING_FILES = [
	MANIFEST,
	"Makefile",
	"makefile",
	"Mintfile",
	"Brewfile",
	"Gemfile",
	"Podfile",
	"Rakefile",
	"justfile",
] as const;

/** Globs for build glue that commonly invokes Swift quality tools. */
const SCRIPT_GLOBS = ["scripts/**/*.sh", "scripts/**/*.swift", "scripts/**/*.rb", "bin/**/*.sh"];

/** Cap on script files swept for tool mentions — keeps the sweep bounded/deterministic. */
const MAX_SCRIPT_FILES = 50;

/**
 * Concatenate the text of the places a Swift repo wires a tool — the manifest,
 * build glue (Make/Mint/Brew/…), CI workflows, and `scripts/` — into one blob a
 * config-first detector can grep with a case-insensitive regex. Missing files are
 * skipped; the script sweep is capped and sorted for determinism.
 */
export async function gatherToolingText(ctx: DetectionContext): Promise<string> {
	const chunks: string[] = [];
	for (const rel of TOOLING_FILES) {
		const text = await ctx.readFile(rel);
		if (text !== null) chunks.push(text);
	}
	for (const wf of await readWorkflows(ctx)) chunks.push(wf.text);
	const scripts = new Set<string>();
	for (const pattern of SCRIPT_GLOBS) {
		for (const hit of await ctx.glob(pattern)) scripts.add(hit);
	}
	for (const rel of [...scripts].sort().slice(0, MAX_SCRIPT_FILES)) {
		const text = await ctx.readFile(rel);
		if (text !== null) chunks.push(text);
	}
	return chunks.join("\n");
}

/** True if `re` matches anywhere in the gathered tooling text. */
export function toolingMentions(toolingText: string, re: RegExp): boolean {
	return re.test(toolingText);
}
