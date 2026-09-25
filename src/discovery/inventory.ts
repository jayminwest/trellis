/**
 * TypeScript source discovery → classified workspace inventory (SPEC §3.1).
 *
 * One deterministic filesystem walk over the audited root produces:
 * - the **packages** (ownership from `package.json` manifests and workspace
 *   declarations — npm/bun/yarn `workspaces` and pnpm `pnpm-workspace.yaml`),
 * - every TS/TSX file classified into exactly one source set
 *   (production/test/generated/vendored/declaration-only), owned by its
 *   nearest ancestor package so nested packages are never double-counted,
 * - the **excluded** scope (build outputs `dist`/`build`/`out`/`coverage` and
 *   config `source.exclude` globs) — counted, never scored,
 * - the **unsupported** scope (non-TS source files and whole non-TS
 *   packages, §3.3) — reported as coverage, never as cleanliness,
 * - the **ignored** scope (dependency dirs, dot dirs, symlinked dirs) —
 *   surfaced by path, never descended into.
 *
 * Guarantees: no package installation, no repository script execution, no
 * network access, no Git requirement — the walk sees uncommitted files and
 * non-Git trees identically. Directory symlinks are never followed (no
 * cycles, no double-counting); symlinked files are followed. All output
 * collections are sorted, so the inventory is stable across filesystem
 * enumeration order.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SourceConfig, SourceCoverage, SourceSet } from "../contract/index.ts";
import { parseYaml } from "../contract/yaml.ts";
import { classifyTsFile, isTypeScriptSource, isUnsupportedSource } from "./classify.ts";
import { matchAnyGlob } from "./glob.ts";

/** Dependency/install dirs never descended into (install-state dependent — not the repo's source). */
const DEPENDENCY_DIRS = new Set(["node_modules"]);

/**
 * Build-output dirs whose TS/TSX content is counted as `excluded` coverage —
 * compiled artifacts are not source debt, but they are reported, not hidden.
 */
const BUILD_OUTPUT_DIRS = new Set(["dist", "build", "out", "coverage"]);

/** Why a directory was skipped without descending. */
export type IgnoredReason = "dependency-dir" | "dot-dir" | "symlink";

/** A directory skipped without descending (surfaced, never counted as clean). */
export interface IgnoredEntry {
	/** Repo-relative POSIX path. */
	path: string;
	reason: IgnoredReason;
}

/** One package boundary discovered from a manifest (or the implicit root). */
export interface WorkspacePackage {
	/** Repo-relative POSIX root; `.` for the repo root. */
	path: string;
	/** Manifest `name`, when a manifest exists and declares one. */
	name?: string;
	/** False only for the implicit root package when no root manifest exists. */
	hasManifest: boolean;
	/** True when the root manifest's workspace declarations name this package (the root is always declared). */
	declared: boolean;
}

/** One TS/TSX file assigned to exactly one source set. */
export interface ClassifiedFile {
	/** Repo-relative POSIX path. */
	path: string;
	sourceSet: SourceSet;
	/** Repo-relative root of the owning (nearest ancestor) package. */
	packagePath: string;
	/** Classification rule that fired (traceability). */
	rule: string;
}

/** A TS/TSX file in excluded scope — counted, never classified. */
export interface ExcludedFile {
	path: string;
	reason: "build-output" | "config-exclude";
}

/** The classified workspace inventory (SPEC §3.1). */
export interface SourceInventory {
	/** Absolute audited root. */
	root: string;
	/** All package boundaries, sorted by path (`.` first). */
	packages: WorkspacePackage[];
	/** Every classified TS/TSX file — each appears exactly once. Sorted by path. */
	files: ClassifiedFile[];
	/** TS/TSX files in excluded scope, sorted by path. */
	excluded: ExcludedFile[];
	/** Unsupported (non-TS) source surface outside excluded/ignored scopes. */
	unsupported: { files: number; byExtension: Record<string, number> };
	/** Directories skipped without descending, sorted by path. */
	ignored: IgnoredEntry[];
	/** Manifest packages owning zero TS/TSX files — whole non-TS packages (§3.3). */
	unsupportedPackages: string[];
}

/** Options for {@link discoverSourceInventory}. */
export interface DiscoverInventoryOptions {
	/** Audit-config source overrides (§6.5); documented defaults when omitted. */
	source?: SourceConfig;
}

/** Mutable walk state threaded through the recursion. */
interface WalkState {
	tsFiles: string[];
	excluded: ExcludedFile[];
	unsupportedByExt: Map<string, number>;
	ignored: IgnoredEntry[];
	/** Repo-relative dirs ("" = root) containing a `package.json`. */
	manifestDirs: string[];
}

/** Record one file entry encountered during the walk. */
function handleFile(
	state: WalkState,
	rel: string,
	name: string,
	inBuildOutput: boolean,
	exclude: readonly string[],
): void {
	if (name === "package.json") {
		const dir = rel === name ? "" : rel.slice(0, -(name.length + 1));
		state.manifestDirs.push(dir);
		return;
	}
	if (isTypeScriptSource(rel)) {
		if (inBuildOutput) state.excluded.push({ path: rel, reason: "build-output" });
		else if (matchAnyGlob(exclude, rel))
			state.excluded.push({ path: rel, reason: "config-exclude" });
		else state.tsFiles.push(rel);
		return;
	}
	if (!inBuildOutput && !matchAnyGlob(exclude, rel) && isUnsupportedSource(rel)) {
		const ext = rel.slice(rel.lastIndexOf(".")).toLowerCase();
		state.unsupportedByExt.set(ext, (state.unsupportedByExt.get(ext) ?? 0) + 1);
	}
}

/** Walk arguments bundled so per-entry helpers stay small. */
interface WalkContext {
	absDir: string;
	relDir: string;
	inBuildOutput: boolean;
	exclude: readonly string[];
	state: WalkState;
}

/** Handle one directory entry: ignore dot/dependency dirs, descend otherwise. */
async function handleDirectory(ctx: WalkContext, name: string, rel: string): Promise<void> {
	if (name.startsWith(".")) {
		ctx.state.ignored.push({ path: rel, reason: "dot-dir" });
		return;
	}
	if (DEPENDENCY_DIRS.has(name)) {
		ctx.state.ignored.push({ path: rel, reason: "dependency-dir" });
		return;
	}
	await walk({
		...ctx,
		absDir: join(ctx.absDir, name),
		relDir: rel,
		inBuildOutput: ctx.inBuildOutput || BUILD_OUTPUT_DIRS.has(name),
	});
}

/** Handle one symlink: follow files, report (never descend) dirs and broken links. */
async function handleSymlink(ctx: WalkContext, name: string, rel: string): Promise<void> {
	const target = await stat(join(ctx.absDir, name)).catch(() => null);
	if (target?.isFile()) handleFile(ctx.state, rel, name, ctx.inBuildOutput, ctx.exclude);
	else ctx.state.ignored.push({ path: rel, reason: "symlink" });
}

/** Recursive walk; never follows directory symlinks, never scans ignored dirs. */
async function walk(ctx: WalkContext): Promise<void> {
	const entries = await readdir(ctx.absDir, { withFileTypes: true });
	const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const entry of sorted) {
		const rel = ctx.relDir === "" ? entry.name : `${ctx.relDir}/${entry.name}`;
		if (entry.isDirectory()) await handleDirectory(ctx, entry.name, rel);
		else if (entry.isFile()) handleFile(ctx.state, rel, entry.name, ctx.inBuildOutput, ctx.exclude);
		else if (entry.isSymbolicLink()) await handleSymlink(ctx, entry.name, rel);
	}
}

/** Parse the manifest at `absPath`; `{}` on any read/parse failure. */
async function readManifest(absPath: string): Promise<Record<string, unknown>> {
	try {
		const parsed: unknown = JSON.parse(await readFile(absPath, "utf8"));
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** Extract string entries from a `packages`-style list (`unknown` from parsed data). */
function stringEntries(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string");
}

/** Workspace globs declared by the root manifest's `workspaces` field (array or `{ packages }`). */
function manifestWorkspaceGlobs(rootManifest: Record<string, unknown>): string[] {
	const workspaces = rootManifest.workspaces;
	if (Array.isArray(workspaces)) return stringEntries(workspaces);
	if (typeof workspaces === "object" && workspaces !== null) {
		return stringEntries((workspaces as Record<string, unknown>).packages);
	}
	return [];
}

/** Workspace globs declared by `pnpm-workspace.yaml`; `[]` when absent or unreadable. */
async function pnpmWorkspaceGlobs(root: string): Promise<string[]> {
	try {
		const parsed: unknown = parseYaml(await readFile(join(root, "pnpm-workspace.yaml"), "utf8"));
		return stringEntries((parsed as Record<string, unknown> | null)?.packages);
	} catch {
		// No pnpm-workspace.yaml (or unreadable) — workspace declarations are optional.
		return [];
	}
}

/** Workspace declaration globs from the root manifest (`workspaces`) and `pnpm-workspace.yaml`. */
async function readWorkspaceGlobs(
	root: string,
	rootManifest: Record<string, unknown>,
): Promise<string[]> {
	return [...manifestWorkspaceGlobs(rootManifest), ...(await pnpmWorkspaceGlobs(root))];
}

/** True when workspace `globs` (with `!` negation) declare the package at repo-relative `dir`. */
function isDeclared(globs: readonly string[], dir: string): boolean {
	const positive = globs.filter((glob) => !glob.startsWith("!"));
	const negative = globs.filter((glob) => glob.startsWith("!")).map((glob) => glob.slice(1));
	return matchAnyGlob(positive, dir) && !matchAnyGlob(negative, dir);
}

/** Nearest ancestor manifest dir owns `relPath`; the root (`.`) owns what nothing else does. */
function ownerOf(relPath: string, manifestDirs: readonly string[]): string {
	let owner = ".";
	let depth = 0;
	for (const dir of manifestDirs) {
		if (dir !== "" && relPath.startsWith(`${dir}/`)) {
			const dirDepth = dir.split("/").length;
			if (dirDepth > depth) {
				owner = dir;
				depth = dirDepth;
			}
		}
	}
	return owner;
}

/** Compare helper: `.` (root) first, then lexicographic. */
function byPath(a: { path: string }, b: { path: string }): number {
	if (a.path === ".") return b.path === "." ? 0 : -1;
	if (b.path === ".") return 1;
	return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * Discover the workspace's TS/TSX files and classify each into exactly one
 * source set (SPEC §3.1). See the module docblock for guarantees.
 */
export async function discoverSourceInventory(
	root: string,
	opts: DiscoverInventoryOptions = {},
): Promise<SourceInventory> {
	const absRoot = resolve(root);
	const exclude = opts.source?.exclude ?? [];

	const state: WalkState = {
		tsFiles: [],
		excluded: [],
		unsupportedByExt: new Map(),
		ignored: [],
		manifestDirs: [],
	};
	await walk({ absDir: absRoot, relDir: "", inBuildOutput: false, exclude, state });

	const manifestDirs = [...new Set(state.manifestDirs)].sort();
	const rootManifest = await readManifest(join(absRoot, "package.json"));
	const workspaceGlobs = await readWorkspaceGlobs(absRoot, rootManifest);

	const packages: WorkspacePackage[] = [];
	for (const dir of manifestDirs) {
		const path = dir === "" ? "." : dir;
		const manifest =
			dir === "" ? rootManifest : await readManifest(join(absRoot, dir, "package.json"));
		const name = typeof manifest.name === "string" ? manifest.name : undefined;
		packages.push({
			path,
			...(name === undefined ? {} : { name }),
			hasManifest: true,
			declared: dir === "" || isDeclared(workspaceGlobs, dir),
		});
	}
	if (!manifestDirs.includes("")) {
		packages.push({ path: ".", hasManifest: false, declared: false });
	}

	const files: ClassifiedFile[] = state.tsFiles.map((rel) => {
		const { sourceSet, rule } = classifyTsFile(rel, opts.source);
		return { path: rel, sourceSet, packagePath: ownerOf(rel, manifestDirs), rule };
	});

	const ownedTs = new Set(files.map((file) => file.packagePath));
	const unsupportedPackages = packages
		.filter((pkg) => pkg.hasManifest && !ownedTs.has(pkg.path))
		.map((pkg) => pkg.path)
		.sort();

	return {
		root: absRoot,
		packages: packages.sort(byPath),
		files: files.sort(byPath),
		excluded: state.excluded.sort(byPath),
		unsupported: {
			files: [...state.unsupportedByExt.values()].reduce((sum, n) => sum + n, 0),
			byExtension: Object.fromEntries([...state.unsupportedByExt.entries()].sort()),
		},
		ignored: state.ignored.sort(byPath),
		unsupportedPackages,
	};
}

/**
 * Project an inventory onto the §6.4 `sourceCoverage` contract shape: per-scope
 * file counts. `sloc` is left to the measurement layer (trellis-d81d/trellis-fbc5);
 * only scopes with a non-zero count are populated beyond the always-present
 * `production` and `test`.
 */
export function toSourceCoverage(inventory: SourceInventory): SourceCoverage {
	const count = (set: SourceSet): number =>
		inventory.files.filter((file) => file.sourceSet === set).length;
	const coverage: SourceCoverage = {
		production: { files: count("production") },
		test: { files: count("test") },
	};
	const generated = count("generated");
	if (generated > 0) coverage.generated = { files: generated };
	const vendored = count("vendored");
	if (vendored > 0) coverage.vendored = { files: vendored };
	const declarations = count("declaration-only");
	if (declarations > 0) coverage["declaration-only"] = { files: declarations };
	if (inventory.excluded.length > 0) {
		coverage.excluded = {
			files: inventory.excluded.length,
			note: "build outputs and config-excluded paths — not analyzed",
		};
	}
	if (inventory.unsupported.files > 0) {
		coverage.unsupported = {
			files: inventory.unsupported.files,
			note: "non-TS sources, not analyzed",
		};
	}
	return coverage;
}
