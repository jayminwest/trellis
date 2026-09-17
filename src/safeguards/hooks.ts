/**
 * Git pre-commit hook inspection (SPEC §5.5, trellis-a97d).
 *
 * Supported surfaces, all **configuration only** — a hook is never executed
 * and its shell body is never interpreted:
 *
 * - `git config core.hooksPath <dir>` wiring in a manifest script, verified
 *   against a committed `<dir>/pre-commit` file (missing target → located
 *   broken-reference finding);
 * - `.husky/pre-commit` (husky v9+), wired when a manifest `prepare` script
 *   invokes `husky`; a declarative `husky` key in package.json (v4) counts as
 *   configuration;
 * - `lefthook.yml` (and spelling variants), wired when a script or CI step
 *   references `lefthook install|run`;
 * - `.pre-commit-config.yaml` (pre-commit framework), wired when CI uses
 *   `pre-commit/action` or any script/CI command references `pre-commit run`.
 *
 * Executable hook configuration (`husky.config.js`, `.huskyrc*`) is
 * unsupported → `unknown`, never guessed. `.git/hooks/` is not committed
 * configuration and is never inspected.
 */
import yaml from "js-yaml";
import type { SafeguardLocation } from "../contract/index.ts";
import type { SafeguardContext, SurfaceEvidence } from "./types.ts";
import { EVIDENCE_RANK } from "./types.ts";
import { brokenPathFindings } from "./wiring.ts";

/** `.husky/pre-commit` hook file (husky v9+ committed hook surface). */
const HUSKY_HOOK = ".husky/pre-commit";
/** Declarative lefthook configs (all spellings). */
const LEFTHOOK_CONFIGS = ["lefthook.yml", "lefthook.yaml", ".lefthook.yml", ".lefthook.yaml"];
/** pre-commit framework configs. */
const PRE_COMMIT_CONFIGS = [".pre-commit-config.yaml", ".pre-commit-config.yml"];
/** Executable hook configuration — unsupported, explicitly unverified. */
const EXECUTABLE_HOOK_CONFIGS = [
	"husky.config.js",
	"husky.config.cjs",
	".huskyrc",
	".huskyrc.js",
	".huskyrc.json",
];

const HOOKS_PATH_RE = /\bgit\s+config\s+core\.hooksPath\s+(\S+)/;
const HUSKY_INSTALL_RE = /\bhusky\b/;
const LEFTHOOK_RE = /\blefthook\s+(?:install|run)\b/;
const PRE_COMMIT_RUN_RE = /\bpre-commit\s+run\b/;
const PRE_COMMIT_ACTION_RE = /^pre-commit\/action@/;

/** True when any script body or CI `run:` command matches `re`. */
function referencedAnywhere(ctx: SafeguardContext, re: RegExp): string | null {
	for (const script of ctx.manifest?.scripts ?? []) {
		if (re.test(script.body)) return `script '${script.name}'`;
	}
	for (const workflow of ctx.workflows) {
		for (const command of workflow.commands) {
			if (re.test(command.text)) return `${workflow.path} line ${command.line}`;
		}
	}
	return null;
}

/** core.hooksPath wiring: script → committed `<dir>/pre-commit`. */
async function inspectHooksPath(ctx: SafeguardContext): Promise<SurfaceEvidence | null> {
	const scripts = ctx.manifest?.scripts ?? [];
	let evidence: SurfaceEvidence | null = null;
	for (const script of scripts) {
		const match = HOOKS_PATH_RE.exec(script.body);
		const dir = match?.[1]?.replace(/^\.?\//, "").replace(/\/$/, "");
		if (dir === undefined || dir.length === 0) continue;
		const hookRel = `${dir}/pre-commit`;
		const scriptLocation: SafeguardLocation = {
			path: "package.json",
			range: { start: { line: script.line }, end: { line: script.line } },
		};
		if (await ctx.fileExists(hookRel)) {
			evidence = {
				level: "structurally-wired",
				locations: [scriptLocation, { path: hookRel }],
				notes: [`script '${script.name}' wires core.hooksPath to committed '${hookRel}'`],
				findings: [],
			};
		} else if (evidence === null) {
			evidence = {
				level: "configured",
				locations: [scriptLocation],
				notes: [
					`script '${script.name}' wires core.hooksPath to '${dir}' but no hook is committed`,
				],
				findings: await brokenPathFindings(
					ctx,
					{ path: "package.json", line: script.line },
					script.body,
					`script '${script.name}'`,
					[hookRel],
				),
			};
		}
	}
	return evidence;
}

/** husky: committed `.husky/pre-commit` + `prepare` install wiring. */
async function inspectHusky(ctx: SafeguardContext): Promise<SurfaceEvidence | null> {
	if (await ctx.fileExists(HUSKY_HOOK)) {
		const prepare = (ctx.manifest?.scripts ?? []).find(
			(s) => s.name === "prepare" && HUSKY_INSTALL_RE.test(s.body),
		);
		return prepare !== undefined
			? {
					level: "structurally-wired",
					locations: [{ path: HUSKY_HOOK }],
					notes: [`husky install wired via script '${prepare.name}'`],
					findings: [],
				}
			: {
					level: "configured",
					locations: [{ path: HUSKY_HOOK }],
					notes: ["no husky install wiring (a 'prepare' script invoking husky) found"],
					findings: [],
				};
	}
	if (ctx.manifest?.huskyConfig === true) {
		return {
			level: "configured",
			locations: [{ path: "package.json" }],
			notes: ["declarative 'husky' key in package.json (husky v4 config)"],
			findings: [],
		};
	}
	return null;
}

/** lefthook YAML config (declarative; wired via a `lefthook install|run` reference). */
async function inspectLefthook(ctx: SafeguardContext): Promise<SurfaceEvidence | null> {
	for (const rel of LEFTHOOK_CONFIGS) {
		const text = await ctx.readText(rel);
		if (text === null) continue;
		const parse = tryYamlMap(text);
		if (!parse.ok)
			return unknownSurface(rel, `lefthook config is not parseable YAML: ${parse.error}`);
		const via = referencedAnywhere(ctx, LEFTHOOK_RE);
		return {
			level: via !== null ? "structurally-wired" : "configured",
			locations: [{ path: rel }],
			notes: [
				via !== null
					? `lefthook install/run referenced from ${via}`
					: "no lefthook install/run reference found in scripts or CI",
			],
			findings: [],
		};
	}
	return null;
}

/** pre-commit framework config (wired via `pre-commit/action` or `pre-commit run`). */
async function inspectPreCommitFramework(ctx: SafeguardContext): Promise<SurfaceEvidence | null> {
	for (const rel of PRE_COMMIT_CONFIGS) {
		const text = await ctx.readText(rel);
		if (text === null) continue;
		const parse = tryYamlMap(text);
		if (!parse.ok)
			return unknownSurface(rel, `pre-commit config is not parseable YAML: ${parse.error}`);
		const ciUses = ctx.workflows.some((w) => w.uses.some((u) => PRE_COMMIT_ACTION_RE.test(u)));
		const via = referencedAnywhere(ctx, PRE_COMMIT_RUN_RE);
		const wiredNote = ciUses
			? "a CI workflow uses pre-commit/action"
			: via !== null
				? `pre-commit run referenced from ${via}`
				: null;
		return {
			level: wiredNote !== null ? "structurally-wired" : "configured",
			locations: [{ path: rel }],
			notes: [wiredNote ?? "no pre-commit/action step or 'pre-commit run' reference found"],
			findings: [],
		};
	}
	return null;
}

/** lefthook / pre-commit-framework YAML configs (first surface found wins). */
async function inspectYamlHookConfigs(ctx: SafeguardContext): Promise<SurfaceEvidence | null> {
	const lefthook = await inspectLefthook(ctx);
	if (lefthook !== null) return lefthook;
	return inspectPreCommitFramework(ctx);
}

function tryYamlMap(text: string): { ok: true } | { ok: false; error: string } {
	try {
		const value: unknown = yaml.load(text);
		if (typeof value !== "object" || value === null) {
			return { ok: false, error: "document is not a mapping" };
		}
		return { ok: true };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : "unparseable YAML" };
	}
}

function unknownSurface(path: string, note: string): SurfaceEvidence {
	return { level: "unknown", locations: [{ path }], notes: [note], findings: [] };
}

/** Merge surfaces: highest rank wins; locations/notes/findings concatenate. */
export function mergeSurfaces(surfaces: readonly SurfaceEvidence[]): SurfaceEvidence {
	const present = surfaces.filter((s) => EVIDENCE_RANK[s.level] > 0);
	if (present.length === 0) return { level: "absent", locations: [], notes: [], findings: [] };
	const top = Math.max(...present.map((s) => EVIDENCE_RANK[s.level]));
	const merged: SurfaceEvidence = { level: "absent", locations: [], notes: [], findings: [] };
	for (const surface of present) {
		if (EVIDENCE_RANK[surface.level] === top) merged.level = surface.level;
		merged.locations.push(...surface.locations);
		merged.notes.push(...surface.notes);
		merged.findings.push(...surface.findings);
	}
	return merged;
}

/** Inspect every supported git pre-commit hook surface. */
export async function inspectGitHooks(ctx: SafeguardContext): Promise<SurfaceEvidence> {
	const surfaces: SurfaceEvidence[] = [];
	const hooksPath = await inspectHooksPath(ctx);
	if (hooksPath !== null) surfaces.push(hooksPath);
	const husky = await inspectHusky(ctx);
	if (husky !== null) surfaces.push(husky);
	const yamlConfigs = await inspectYamlHookConfigs(ctx);
	if (yamlConfigs !== null) surfaces.push(yamlConfigs);
	for (const rel of EXECUTABLE_HOOK_CONFIGS) {
		if (await ctx.fileExists(rel)) {
			surfaces.push(
				unknownSurface(rel, "executable hook configuration is unsupported and unverified"),
			);
		}
	}
	return mergeSurfaces(surfaces);
}
