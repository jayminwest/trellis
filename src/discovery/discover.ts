/**
 * App discovery (SPEC §8.2) — find **independently-deployable directories** as
 * apps before app-scope scoring. A directory is an app when it carries a
 * deployable marker: a `package.json` with `bin`/`main`, a `pyproject.toml`, a
 * `Package.swift`, or a `Dockerfile` (service dir). Nested manifests under build
 * outputs / vendored trees (`node_modules`, `vendor`, `dist`, …) are excluded so
 * a bundled dependency never registers as an app.
 *
 * If **0 apps are found**, the repo root is exactly **1 app** (SPEC §8.2) — so
 * downstream app-scope aggregation always has ≥1 app and `monorepo_tooling` /
 * `version_drift_detection` no-op honestly for single-app repos.
 *
 * Discovery is pure given a filesystem: the result is a function of the tree
 * alone, with a deterministic order (sorted by `path`). The optional `languages`
 * hint (SPEC §6.5) overrides auto-detection for every app when present.
 */
import { readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { App, DiscoverOptions, Language } from "./types.ts";

/**
 * Directory names never descended into: dependency trees, vendored code, and
 * build/cache outputs (SPEC §8.2 — "nested manifests under
 * node_modules/vendor/build outputs excluded"). Any directory whose name starts
 * with `.` is also skipped (`.git`, `.next`, `.venv`, …).
 */
const EXCLUDED_DIRS = new Set([
	"node_modules",
	"vendor",
	"dist",
	"build",
	"out",
	"coverage",
	"target", // rust/swift build output
	"__pycache__",
	"venv",
]);

/** Default maximum depth descended below the repo root. */
export const DEFAULT_MAX_DEPTH = 8;

/** What {@link detectDir} found about a single directory. */
interface DirFacts {
	/** True when a deployable marker is present (the dir is an app). */
	isApp: boolean;
	/** Languages detected from manifest/config files in this dir. */
	languages: Language[];
	/** Best-effort label from a package manifest (`name` ?? `description`). */
	description?: string;
}

/** Sort + de-dupe a language list for stable, comparable output. */
function normLanguages(langs: Iterable<Language>): Language[] {
	return [...new Set(langs)].sort();
}

/** Parse `package.json`, returning `{}` on any read/parse failure. */
async function readPackageJson(absDir: string): Promise<Record<string, unknown>> {
	const file = Bun.file(join(absDir, "package.json"));
	if (!(await file.exists())) return {};
	try {
		const parsed: unknown = await file.json();
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/**
 * Inspect one directory for deployable markers and languages (SPEC §8.2/§8.3):
 * - `package.json` → typescript; an app when it has `bin` or `main`.
 * - `tsconfig.json` → typescript.
 * - `Package.swift` → swift; always an app.
 * - `pyproject.toml` → python; always an app.
 * - `setup.cfg` → python (language only — not an app marker on its own).
 * - `Dockerfile` → an app (service dir), languages from its siblings.
 */
async function detectDir(absDir: string, names: ReadonlySet<string>): Promise<DirFacts> {
	const languages = new Set<Language>();
	let isApp = false;
	let description: string | undefined;

	if (names.has("package.json")) {
		languages.add("typescript");
		const pkg = await readPackageJson(absDir);
		if (pkg.bin !== undefined || pkg.main !== undefined) isApp = true;
		const label = pkg.name ?? pkg.description;
		if (typeof label === "string" && label.length > 0) description = label;
	}
	if (names.has("tsconfig.json")) languages.add("typescript");
	if (names.has("Package.swift")) {
		languages.add("swift");
		isApp = true;
	}
	if (names.has("pyproject.toml")) {
		languages.add("python");
		isApp = true;
	}
	if (names.has("setup.cfg")) languages.add("python");
	if (names.has("Dockerfile")) isApp = true;

	return { isApp, languages: normLanguages(languages), description };
}

/** Read a directory's entries, splitting file names from sub-directory names. */
async function scanDir(absDir: string): Promise<{ files: Set<string>; subdirs: string[] }> {
	const entries = await readdir(absDir, { withFileTypes: true });
	const files = new Set<string>();
	const subdirs: string[] = [];
	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (!entry.name.startsWith(".") && !EXCLUDED_DIRS.has(entry.name)) subdirs.push(entry.name);
		} else if (entry.isFile()) {
			files.add(entry.name);
		}
	}
	return { files, subdirs };
}

/** Recursively collect app directories below `absDir` into `out`. */
async function walk(
	absDir: string,
	relPath: string,
	depth: number,
	maxDepth: number,
	out: App[],
): Promise<void> {
	const { files, subdirs } = await scanDir(absDir);
	const facts = await detectDir(absDir, files);
	if (facts.isApp) {
		out.push({
			path: relPath === "" ? "." : relPath,
			languages: facts.languages,
			description: facts.description ?? basename(absDir),
		});
	}
	if (depth >= maxDepth) return;
	for (const name of subdirs) {
		await walk(
			join(absDir, name),
			relPath === "" ? name : `${relPath}/${name}`,
			depth + 1,
			maxDepth,
			out,
		);
	}
}

/**
 * Discover the apps in `repoPath` (SPEC §8.2). Returns ≥1 app, sorted by `path`.
 * When no deployable directory is found the repo root (`.`) is returned as a
 * single app with its detected (or hinted) languages. When `opts.languages` is
 * given it overrides auto-detection for every app.
 */
export async function discoverApps(repoPath: string, opts: DiscoverOptions = {}): Promise<App[]> {
	const root = resolve(repoPath);
	const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;

	const found: App[] = [];
	await walk(root, "", 0, maxDepth, found);

	// SPEC §8.2: 0 found → the repo root is exactly 1 app.
	const apps =
		found.length > 0
			? found
			: [
					{
						path: ".",
						languages: (await detectDir(root, (await scanDir(root)).files)).languages,
						description: basename(root),
					},
				];

	const hinted = opts.languages
		? apps.map((app) => ({ ...app, languages: normLanguages(opts.languages as Language[]) }))
		: apps;

	return hinted.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Project discovered apps onto the report's §6.3 `apps` shape:
 * `{ [path]: { description } }`.
 */
export function toAppMap(apps: readonly App[]): Record<string, { description: string }> {
	const map: Record<string, { description: string }> = {};
	for (const app of apps) map[app.path] = { description: app.description };
	return map;
}
