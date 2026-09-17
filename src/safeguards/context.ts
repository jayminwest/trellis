/**
 * Safeguard context loading (SPEC §5.5, trellis-a97d).
 *
 * Reads the two configuration surfaces every inspector shares — the root
 * `package.json` manifest and the GitHub Actions workflows — under the
 * documented subset of {@link SafeguardContext}. Parsing is deliberately
 * shallow and total: a malformed manifest or an unusual workflow never
 * throws, it degrades to `parseError` / fewer commands.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
	ManifestModel,
	SafeguardContext,
	ScriptEntry,
	WorkflowCommand,
	WorkflowModel,
} from "./types.ts";

const MANIFEST_PATH = "package.json";
const WORKFLOWS_DIR = ".github/workflows";

/** Read a file below `root` as UTF-8; `null` when absent or unreadable. */
async function readTextFile(root: string, rel: string): Promise<string | null> {
	try {
		return await readFile(join(root, rel), "utf8");
	} catch {
		return null;
	}
}

/** True when `rel` names an existing file below `root`. */
async function fileExists(root: string, rel: string): Promise<boolean> {
	try {
		return (await stat(join(root, rel))).isFile();
	} catch {
		return false;
	}
}

/** True when `rel` names an existing file or directory below `root`. */
async function pathExists(root: string, rel: string): Promise<boolean> {
	try {
		await stat(join(root, rel));
		return true;
	} catch {
		return false;
	}
}

const KEY_RE = /^(\s*)"((?:[^"\\]|\\.)*)"\s*:\s*(.*)$/;
const STRING_VALUE_RE = /^"((?:[^"\\]|\\.)*)"$/;

/** Net brace delta of `text` (`{` minus `}`), used for the scripts-object scan. */
function braceDelta(text: string): number {
	let delta = 0;
	for (const ch of text) {
		if (ch === "{") delta++;
		if (ch === "}") delta--;
	}
	return delta;
}

/** The brace depth after a `"scripts": {` opening line, or `null` when `line` isn't one. */
function scriptsStartDepth(line: string): number | null {
	const match = KEY_RE.exec(line);
	if (match?.[2] !== "scripts" || !(match[3] ?? "").startsWith("{")) return null;
	return braceDelta(line.slice(line.indexOf("{")));
}

/** One `name: "body"` entry with its 1-based line, or `null` for non-string values. */
function parseScriptEntry(line: string, lineNumber: number): ScriptEntry | null {
	const match = KEY_RE.exec(line);
	if (match === null) return null;
	const value = (match[3] ?? "").replace(/,?\s*$/, "");
	const stringValue = STRING_VALUE_RE.exec(value);
	if (stringValue === null) return null;
	return {
		name: match[2] ?? "",
		body: JSON.parse(`"${stringValue[1]}"`) as string,
		line: lineNumber,
	};
}

/**
 * Locate the `"scripts"` entries with 1-based lines via a brace-depth scan of
 * the raw text. This is location-preserving on purpose: `JSON.parse` alone
 * cannot say where a script lives, and broken-reference findings must point
 * at a line. Documented subset: one entry per line; a single-line scripts
 * object and bodies containing braces are unsupported formatting.
 */
function locateScripts(raw: string): ScriptEntry[] {
	const lines = raw.split("\n");
	const startIndex = lines.findIndex((line) => scriptsStartDepth(line) !== null);
	if (startIndex < 0) return [];
	let depth = scriptsStartDepth(lines[startIndex] ?? "") ?? 0;
	if (depth <= 0) return []; // single-line `{}` — unsupported formatting
	const entries: ScriptEntry[] = [];
	for (let i = startIndex + 1; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const entry = depth === 1 ? parseScriptEntry(line, i + 1) : null;
		if (entry !== null) entries.push(entry);
		depth += braceDelta(line);
		if (depth <= 0) break;
	}
	return entries;
}

/** Parse the root manifest; `null` when absent, `parseError` when malformed. */
export async function loadManifest(root: string): Promise<ManifestModel | null> {
	const raw = await readTextFile(root, MANIFEST_PATH);
	if (raw === null) return null;
	let parsed: Record<string, unknown>;
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return {
				path: MANIFEST_PATH,
				scripts: [],
				jscpdConfig: false,
				huskyConfig: false,
				parseError: "package.json is not a JSON object",
			};
		}
		parsed = value as Record<string, unknown>;
	} catch (error) {
		return {
			path: MANIFEST_PATH,
			scripts: [],
			jscpdConfig: false,
			huskyConfig: false,
			parseError: error instanceof Error ? error.message : "unparseable JSON",
		};
	}
	return {
		path: MANIFEST_PATH,
		scripts: locateScripts(raw),
		jscpdConfig: typeof parsed.jscpd === "object" && parsed.jscpd !== null,
		huskyConfig: typeof parsed.husky === "object" && parsed.husky !== null,
	};
}

/**
 * Reduce one workflow text to the documented subset: `run:` scalar and block
 * values (block lines keep their own line numbers) and `uses:` values.
 * Everything else — jobs, `if:` conditionals, expressions — is ignored.
 */
const RUN_SCALAR_RE = /^(\s*)-?\s*run:\s*(.+)$/;
const RUN_BLOCK_RE = /^(\s*)-?\s*run:\s*([|>])-?\s*$/;
const USES_RE = /^\s*-?\s*uses:\s*(\S+)\s*$/;

/** Push every line of a `run: |`/`run: >` block; return the last consumed index. */
function consumeRunBlock(
	lines: readonly string[],
	start: number,
	parentIndent: number,
	commands: WorkflowCommand[],
): number {
	let last = start;
	for (let j = start + 1; j < lines.length; j++) {
		const inner = lines[j] ?? "";
		if (inner.trim().length === 0) continue;
		const indent = inner.length - inner.trimStart().length;
		if (indent <= parentIndent) break;
		commands.push({ text: inner.trim(), line: j + 1 });
		last = j;
	}
	return last;
}

export function extractWorkflowCommands(path: string, text: string): WorkflowModel {
	const lines = text.split("\n");
	const commands: WorkflowCommand[] = [];
	const uses: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const block = RUN_BLOCK_RE.exec(line);
		if (block !== null) {
			i = consumeRunBlock(lines, i, (block[1] ?? "").length, commands);
			continue;
		}
		const scalar = RUN_SCALAR_RE.exec(line);
		if (scalar !== null) {
			commands.push({ text: (scalar[2] ?? "").trim(), line: i + 1 });
			continue;
		}
		const usesMatch = USES_RE.exec(line);
		if (usesMatch !== null) uses.push(usesMatch[1] ?? "");
	}
	return { path, commands, uses };
}

/** Load every workflow under `.github/workflows/` (sorted for determinism). */
export async function loadWorkflows(root: string): Promise<WorkflowModel[]> {
	let names: string[];
	try {
		names = await readdir(join(root, WORKFLOWS_DIR));
	} catch {
		return [];
	}
	const workflows: WorkflowModel[] = [];
	for (const name of names.filter((n) => n.endsWith(".yml") || n.endsWith(".yaml")).sort()) {
		const rel = `${WORKFLOWS_DIR}/${name}`;
		const text = await readTextFile(root, rel);
		if (text !== null) workflows.push(extractWorkflowCommands(rel, text));
	}
	return workflows;
}

/** Build the shared context: manifest + workflows + file probes. Never throws. */
export async function loadSafeguardContext(root: string): Promise<SafeguardContext> {
	const [manifest, workflows] = await Promise.all([loadManifest(root), loadWorkflows(root)]);
	return {
		root,
		manifest,
		workflows,
		fileExists: (rel) => fileExists(root, rel),
		pathExists: (rel) => pathExists(root, rel),
		readText: (rel) => readTextFile(root, rel),
	};
}
