/**
 * Shared read-only helpers for the Python adapter detectors (SPEC §8.3).
 *
 * Like the other adapters everything routes through the {@link DetectionContext}
 * capabilities — no direct fs — so the adapter inherits repo-containment and the
 * never-throws guarantee. Python tool config is scattered across several conventions
 * (a `[tool.X]` table in `pyproject.toml`, an INI `[X]` section in `setup.cfg` /
 * `tox.ini`, a dedicated dotfile like `.flake8` / `mypy.ini`, or a bare mention in
 * build glue / pre-commit / requirements), so the Python-specific surface is one
 * {@link locateTool} probe that checks those four places in order and a
 * {@link gatherToolingText} sweep config-first detectors grep for a tool by name.
 * We deliberately do **not** parse TOML/INI — config-first detection is a presence
 * check, and regex over the raw text is enough (and matches the Swift adapter's
 * manifest-text approach), so the adapter carries no parser dependency.
 */
import { readWorkflows } from "../../common/util.ts";
import type { DetectionContext } from "../../types.ts";

/** The PEP 621 project manifest — discovery tags an app `python` on its presence. */
export const MANIFEST = "pyproject.toml";

/** Read the project manifest text, or `null` when there is no `pyproject.toml`. */
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

/** The shared INI/TOML config files a `[tool.X]` / `[X]` section can live in. */
const SHARED_CONFIG_FILES = ["pyproject.toml", "setup.cfg", "tox.ini"] as const;

/**
 * Where a tool can be configured. A tool counts as configured when ANY of: a
 * dedicated `file` is present; `configRe` matches one of the shared config files
 * (pyproject / setup.cfg / tox.ini — the `[tool.X]` table or INI section); or the
 * tool is `mention`ed anywhere in the gathered build tooling (Makefile, CI,
 * pre-commit, requirements, scripts).
 */
export interface ToolSpec {
	/** Dedicated config filenames whose mere presence proves configuration. */
	readonly files?: readonly string[];
	/** A `[tool.X]` table / INI `[X]` section pattern in a shared config file. */
	readonly configRe?: RegExp;
	/** A word the tool is named by when wired via build glue / CI / pre-commit. */
	readonly mention?: RegExp;
}

/**
 * Locate where `spec`'s tool is configured, returning a short human descriptor of
 * the location (`'ruff.toml'`, `'pyproject.toml'`, `build tooling`) or `null` when
 * it is configured nowhere. The check order is cheapest-and-most-specific first.
 */
export async function locateTool(ctx: DetectionContext, spec: ToolSpec): Promise<string | null> {
	if (spec.files !== undefined) {
		const hit = await firstPresent(ctx, spec.files);
		if (hit !== null) return `'${hit}'`;
	}
	if (spec.configRe !== undefined) {
		for (const rel of SHARED_CONFIG_FILES) {
			const text = await ctx.readFile(rel);
			if (text !== null && spec.configRe.test(text)) return `'${rel}'`;
		}
	}
	if (spec.mention !== undefined && toolingMentions(await gatherToolingText(ctx), spec.mention)) {
		return "build tooling";
	}
	return null;
}

/** Filenames whose presence/contents reveal which Python tools a repo wires up. */
const TOOLING_FILES = [
	MANIFEST,
	"setup.cfg",
	"setup.py",
	"tox.ini",
	"pytest.ini",
	"noxfile.py",
	"Makefile",
	"makefile",
	"justfile",
	"requirements.txt",
	"requirements-dev.txt",
	"dev-requirements.txt",
	"requirements-test.txt",
	"Pipfile",
	".pre-commit-config.yaml",
	".pre-commit-config.yml",
] as const;

/** Globs for build glue / requirement sets that commonly invoke Python quality tools. */
const SCRIPT_GLOBS = [
	"scripts/**/*.sh",
	"scripts/**/*.py",
	"bin/**/*.sh",
	"requirements/*.txt",
] as const;

/** Cap on swept script/requirement files — keeps the sweep bounded/deterministic. */
const MAX_SCRIPT_FILES = 50;

/**
 * Concatenate the text of the places a Python repo wires a tool — the manifest,
 * INI configs, build glue (Make/nox/just), requirement sets, pre-commit, and CI
 * workflows — into one blob a config-first detector can grep with a regex. Missing
 * files are skipped; the script sweep is capped and sorted for determinism.
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

/**
 * Concatenate the mypy-configuration surfaces (manifest, `setup.cfg`, `tox.ini`,
 * and the dedicated `mypy.ini` / `.mypy.ini`) plus the build tooling into one blob
 * — used by detectors that grade a mypy *setting* (e.g. `strict`) rather than mere
 * presence.
 */
export async function gatherMypyConfigText(ctx: DetectionContext): Promise<string> {
	const chunks: string[] = [];
	for (const rel of [MANIFEST, "setup.cfg", "tox.ini", "mypy.ini", ".mypy.ini"]) {
		const text = await ctx.readFile(rel);
		if (text !== null) chunks.push(text);
	}
	chunks.push(await gatherToolingText(ctx));
	return chunks.join("\n");
}
