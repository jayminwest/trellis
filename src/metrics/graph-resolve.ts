/**
 * Workspace-aware import resolution (SPEC §5.4, trellis-d214).
 *
 * {@link createGraphResolver} resolves one import specifier at a time against
 * **local files and configuration only** — the network is never touched and
 * `node_modules` is never consulted (the guarded host reports dependency
 * directories as empty), so an audit over a tree with absent dependencies
 * resolves exactly the graph the source alone defines (SPEC §8).
 *
 * Resolution order for one specifier (documented, binding):
 *
 * 1. **Relative** (`./`, `../`) — TypeScript module resolution from the
 *    importing file: extension substitution (`.js`→`.ts`, `.mjs`→`.mts`,
 *    `.cjs`→`.cts`), extension appending (`.ts`/`.tsx`/`.d.ts`), and
 *    directory `/index` mapping.
 * 2. **tsconfig aliases** — the *governing* `tsconfig.json` is the nearest
 *    one walking up from the importing file (stopping at the audited root;
 *    named variants like `tsconfig.build.json` never govern). Its `paths`
 *    (relative to `baseUrl`, or to the tsconfig's directory when `baseUrl`
 *    is undeclared) and `baseUrl` apply via the pinned compiler's own
 *    resolution. An undeclared `moduleResolution` defaults to `bundler`.
 *    `extends` chains resolve through the same guarded host; an unreadable
 *    config contributes no options (recorded in `configs`).
 * 3. **Workspace packages** — a bare specifier naming a workspace package
 *    (manifest `name` from discovery) resolves through that package's own
 *    manifest: `exports` (string or one level of conditions, tried in the
 *    order `import` → `require` → `default` → `types`; a single `*` wildcard
 *    per key/target), then `main`, then `types`, then `index` at the package
 *    root. A package **with** an `exports` map encapsulates: a subpath with
 *    no matching entry is `unresolved` (`exports-encapsulation`), not a file
 *    probe. Each candidate then resolves like a relative specifier.
 * 4. **External** — anything else (including `node:` builtins) is an
 *    `external` edge recorded by package name, never resolved into.
 *
 * A resolved target is classified against the audited inventory: inventoried
 * ⇒ `local`; existing but not classified (excluded build output, non-TS
 * siblings, ignored dirs) ⇒ `out-of-scope`; above the root ⇒ `unresolved`
 * (`outside-root`). Bare specifiers that matched a tsconfig path mapping or
 * a workspace package name but produced no file are `unresolved`
 * (`no-target`) — distinguishable from externals (SPEC §5.4).
 */
import { dirname, join, relative } from "node:path";
import ts from "typescript";
import type { SourceInventory } from "../discovery/index.ts";
import type { ImportSite } from "./graph-imports.ts";
import type { EdgeResolution, GraphConfig } from "./graph-types.ts";
import { exportsCandidates, manifestCandidates, wildcardMatch } from "./graph-workspace.ts";

/** Options used when no tsconfig governs a file (and the base for alias lookup). */
const DEFAULT_OPTIONS: ts.CompilerOptions = {
	moduleResolution: ts.ModuleResolutionKind.Bundler,
	allowJs: true,
	resolveJsonModule: true,
};

/** The resolver: per-site resolution plus the tsconfigs actually consulted. */
export interface GraphResolver {
	resolve(fromPath: string, site: ImportSite): EdgeResolution;
	configs(): GraphConfig[];
}

/** True when `absPath` lives under a `node_modules` directory (never consulted). */
function isDependencyPath(absPath: string): boolean {
	return absPath.replace(/\\/g, "/").split("/").includes("node_modules");
}

/** A `ts.sys`-backed host that reports dependency directories as absent. */
function guardedHost(root: string): ts.ModuleResolutionHost & ts.ParseConfigHost {
	return {
		fileExists: (path) => !isDependencyPath(path) && ts.sys.fileExists(path),
		readFile: (path) => (isDependencyPath(path) ? undefined : ts.sys.readFile(path)),
		directoryExists: (path) => !isDependencyPath(path) && (ts.sys.directoryExists?.(path) ?? false),
		getCurrentDirectory: () => root,
		getDirectories: (path) => (isDependencyPath(path) ? [] : ts.sys.getDirectories(path)),
		useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
		readDirectory: (path, extensions, excludes, includes, depth) =>
			isDependencyPath(path)
				? []
				: ts.sys.readDirectory(path, extensions, excludes, includes, depth),
	};
}

/** Repo-relative POSIX path of `absPath`, or `null` when above the root. */
function toRepoRelative(root: string, absPath: string): string | null {
	const rel = relative(root, absPath).replace(/\\/g, "/");
	return rel === "" || rel.startsWith("..") ? null : rel;
}

/** The package-name portion of a bare specifier (`@scope/name` or `name`). */
function packageNameOf(specifier: string): string {
	const segments = specifier.split("/");
	return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : (segments[0] ?? specifier);
}

/** A lazily-parsed governing tsconfig. */
interface GoverningConfig {
	/** Repo-relative path of the tsconfig. */
	path: string;
	status: "parsed" | "unreadable";
	options: ts.CompilerOptions;
}

/** Read and parse one tsconfig; an unreadable config contributes no options. */
function parseConfig(root: string, absPath: string, host: ts.ParseConfigHost): GoverningConfig {
	const rel = toRepoRelative(root, absPath) ?? absPath;
	const read = ts.readConfigFile(absPath, host.readFile);
	if (read.error !== undefined) {
		return { path: rel, status: "unreadable", options: { ...DEFAULT_OPTIONS } };
	}
	const parsed = ts.parseJsonConfigFileContent(read.config, host, dirname(absPath));
	const options: ts.CompilerOptions = { ...DEFAULT_OPTIONS, ...parsed.options };
	if (options.moduleResolution === undefined) {
		options.moduleResolution = DEFAULT_OPTIONS.moduleResolution;
	}
	// TS 5+ semantics: `paths` without `baseUrl` resolve against the config's directory.
	if (options.paths !== undefined && options.baseUrl === undefined) {
		options.baseUrl = dirname(absPath);
	}
	return { path: rel, status: "parsed", options };
}

/** Mutable resolver state threaded through the helpers. */
interface ResolverState {
	root: string;
	host: ts.ModuleResolutionHost & ts.ParseConfigHost;
	inventory: ReadonlySet<string>;
	packagesByName: ReadonlyMap<string, string>;
	manifestCache: Map<string, Record<string, unknown>>;
	configByDir: Map<string, string | null>;
	configByPath: Map<string, GoverningConfig>;
}

/** Read (and cache) the manifest of the workspace package at repo-relative `pkgPath`. */
function packageManifest(state: ResolverState, pkgPath: string): Record<string, unknown> {
	const cached = state.manifestCache.get(pkgPath);
	if (cached !== undefined) return cached;
	let manifest: Record<string, unknown> = {};
	try {
		const text = state.host.readFile(join(state.root, pkgPath, "package.json"));
		const parsed: unknown = text === undefined ? null : JSON.parse(text);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			manifest = parsed as Record<string, unknown>;
		}
	} catch {
		manifest = {};
	}
	state.manifestCache.set(pkgPath, manifest);
	return manifest;
}

/** The governing tsconfig options for the file at `absFile` (lazily parsed, cached). */
function governingOptions(state: ResolverState, absFile: string): ts.CompilerOptions {
	const visited: string[] = [];
	let dir = dirname(absFile);
	let found: string | null = null;
	for (;;) {
		const cached = state.configByDir.get(dir);
		if (cached !== undefined) {
			found = cached;
			break;
		}
		visited.push(dir);
		const candidate = join(dir, "tsconfig.json");
		if (state.host.fileExists(candidate)) {
			found = candidate;
			break;
		}
		if (dir === state.root) break;
		dir = dirname(dir);
	}
	for (const seen of visited) state.configByDir.set(seen, found);
	return optionsOfCachedConfig(state, found);
}

/** Options of a cached (or newly parsed) config; `null` path means no config governs. */
function optionsOfCachedConfig(state: ResolverState, absPath: string | null): ts.CompilerOptions {
	if (absPath === null) return DEFAULT_OPTIONS;
	let config = state.configByPath.get(absPath);
	if (config === undefined) {
		config = parseConfig(state.root, absPath, state.host);
		state.configByPath.set(absPath, config);
	}
	return config.options;
}

/** Classify an absolute resolved target against the audited inventory. */
function classifyTarget(state: ResolverState, absTarget: string): EdgeResolution {
	const rel = toRepoRelative(state.root, absTarget);
	if (rel === null) {
		return {
			status: "unresolved",
			reason: "outside-root",
			detail: "resolves above the audited root",
		};
	}
	return state.inventory.has(rel)
		? { status: "local", target: rel }
		: { status: "out-of-scope", target: rel };
}

/** Run the pinned compiler's module resolution for `specifier` from `absFrom`. */
function resolveModule(
	state: ResolverState,
	specifier: string,
	absFrom: string,
	options: ts.CompilerOptions,
): string | null {
	const resolved = ts.resolveModuleName(specifier, absFrom, options, state.host).resolvedModule;
	return resolved === undefined || resolved.isExternalLibraryImport === true
		? null
		: resolved.resolvedFileName;
}

/** True when any tsconfig `paths` pattern matches `specifier` (failing aliases are local intent). */
function matchesPathPattern(options: ts.CompilerOptions, specifier: string): boolean {
	for (const pattern of Object.keys(options.paths ?? {})) {
		if (wildcardMatch(pattern, specifier) !== null || pattern === specifier) return true;
	}
	return false;
}

/** Resolve one candidate path inside a workspace package (relative-style resolution from its root). */
function resolvePackageCandidate(
	state: ResolverState,
	pkgPath: string,
	candidate: string,
	options: ts.CompilerOptions,
): string | null {
	const cleaned = candidate.replace(/^\.\//, "");
	return resolveModule(state, `./${cleaned}`, join(state.root, pkgPath, "package.json"), options);
}

/** Resolve a bare specifier against the workspace package `pkgPath` (exports/main/types/index). */
function resolveWorkspacePackage(
	state: ResolverState,
	pkgPath: string,
	subpath: string,
	options: ts.CompilerOptions,
): EdgeResolution {
	const manifest = packageManifest(state, pkgPath);
	let candidates: string[];
	if (manifest.exports !== undefined) {
		const looked = exportsCandidates(manifest.exports, subpath);
		if ("failure" in looked) {
			return {
				status: "unresolved",
				reason: looked.failure,
				detail: `workspace package '${pkgPath}' has no supported exports entry for './${subpath || "."}'`,
			};
		}
		candidates = looked.candidates;
	} else {
		candidates = manifestCandidates(manifest, subpath);
	}
	for (const candidate of candidates) {
		const resolved = resolvePackageCandidate(state, pkgPath, candidate, options);
		if (resolved !== null) return classifyTarget(state, resolved);
	}
	return {
		status: "unresolved",
		reason: "no-target",
		detail: `workspace package '${pkgPath}' entry points resolved to no file`,
	};
}

/** Resolve a bare (non-relative) specifier: aliases, then workspace packages, then external. */
function resolveBare(
	state: ResolverState,
	specifier: string,
	absFrom: string,
	options: ts.CompilerOptions,
): EdgeResolution {
	if (specifier.startsWith("node:")) {
		return { status: "external", packageName: specifier };
	}
	const aliased = resolveModule(state, specifier, absFrom, options);
	if (aliased !== null) return classifyTarget(state, aliased);
	if (matchesPathPattern(options, specifier)) {
		return {
			status: "unresolved",
			reason: "no-target",
			detail: `matches a tsconfig path mapping but resolved to no file`,
		};
	}
	const name = packageNameOf(specifier);
	const pkgPath = state.packagesByName.get(name);
	if (pkgPath !== undefined) {
		return resolveWorkspacePackage(state, pkgPath, specifier.slice(name.length + 1), options);
	}
	return { status: "external", packageName: name };
}

/**
 * Create the resolver for one audit. `source` supplies workspace package
 * names (manifest-discovered) and the inventoried file set; all filesystem
 * access goes through the guarded host (no `node_modules`, no network).
 */
export function createGraphResolver(source: SourceInventory): GraphResolver {
	const state: ResolverState = {
		root: source.root,
		host: guardedHost(source.root),
		inventory: new Set(source.files.map((file) => file.path)),
		packagesByName: new Map(
			source.packages.flatMap((pkg) => (pkg.name === undefined ? [] : [[pkg.name, pkg.path]])),
		),
		manifestCache: new Map(),
		configByDir: new Map(),
		configByPath: new Map(),
	};
	const resolve = (fromPath: string, site: ImportSite): EdgeResolution => {
		if (site.specifier === null) {
			return {
				status: "unresolved",
				reason: "non-literal-dynamic",
				detail: "dynamic import argument is not a string literal",
			};
		}
		const absFrom = join(state.root, fromPath);
		const options = governingOptions(state, absFrom);
		if (site.specifier.startsWith("./") || site.specifier.startsWith("../")) {
			const resolved = resolveModule(state, site.specifier, absFrom, options);
			return resolved === null
				? {
						status: "unresolved",
						reason: "no-target",
						detail: `relative specifier '${site.specifier}' matched no file`,
					}
				: classifyTarget(state, resolved);
		}
		return resolveBare(state, site.specifier, absFrom, options);
	};
	const configs = (): GraphConfig[] =>
		[...state.configByPath.values()]
			.map((config) => ({ path: config.path, status: config.status }))
			.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return { resolve, configs };
}
