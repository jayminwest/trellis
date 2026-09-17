/**
 * Project-aware declarative context enumeration for the provider staging
 * layer (SPEC §16.4, plan `pl-43c5` — trellis-2fe6).
 *
 * Staged views are **source-only by default**; `project-aware` mode opts in
 * to this narrowly bounded context: package manifests, root-level tsconfig
 * files, and the *declarative strings* those manifests carry — dependency
 * names and entry roots. Nothing here is executed, resolved, or installed:
 * `node_modules` contents are never copied (out of scope, §16.4), and the
 * target's own tool configuration is never executed or trusted — only these
 * enumerated files cross into the staged view. Every result lands in typed,
 * sorted records so staging provenance (§16.2 analysis identity) carries the
 * exact semantics the analysis consumed.
 *
 * Failure handling mirrors the staging layer: unreadable context is reported
 * as an explicit read failure, and a manifest that cannot be interpreted is
 * still staged as bytes with a located issue — never silently dropped, and
 * never a reason to abort the audit path.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { byRelativePath, messageOf, sha256Hex } from "./staging.ts";

/** Roles a declarative context file can play in a staged view. */
export type ContextRole = "manifest" | "tsconfig";

/** The manifest sections declared dependency names are collected from. */
export const DEPENDENCY_SECTIONS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
] as const;

export type DependencySection = (typeof DEPENDENCY_SECTIONS)[number];

/** One enumerated context file, ready to stage (bytes + fingerprint). */
export interface ContextRead {
	/** Repo-relative path. */
	path: string;
	role: ContextRole;
	bytes: Uint8Array;
	sha256: string;
}

/** A context file that was expected but could not be read. */
export interface ContextReadFailure {
	path: string;
	reason: string;
}

/** A staged context file whose declarations could not be interpreted. */
export interface ContextIssue {
	path: string;
	reason: string;
}

/** Declared dependency names per package and section (sorted, de-duplicated). */
export interface DependencyDeclarations {
	packagePath: string;
	sections: Record<DependencySection, string[]>;
}

/** Declared entry roots per package (sorted, de-duplicated). */
export interface DeclaredEntries {
	packagePath: string;
	entries: string[];
}

/** The enumerated declarative context of one staging request. */
export interface ProjectContext {
	/** Context files to stage, sorted by path. */
	files: ContextRead[];
	/** Expected-but-unreadable context, sorted by path. */
	readFailures: ContextReadFailure[];
	/** Staged-but-uninterpretable context, sorted by path. */
	issues: ContextIssue[];
	/** Dependency names per package, sorted by package path. */
	dependencies: DependencyDeclarations[];
	/** Entry roots per package, sorted by package path. */
	entryRoots: DeclaredEntries[];
}

const TSCONFIG_NAME_RE = /^tsconfig\.[^.]+\.json$/;

/** Manifest fields that declare a single string entry root. */
const ENTRY_FIELDS = ["main", "module", "types", "typings"] as const;

/** True for root-level tsconfig file names (`tsconfig.json`, `tsconfig.*.json`). */
function isTsconfigName(name: string): boolean {
	return name === "tsconfig.json" || TSCONFIG_NAME_RE.test(name);
}

/** Repo-relative path of `name` inside package `pkg` (`.` is the root package). */
function toPackageRelative(pkg: string, name: string): string {
	return pkg === "." ? name : `${pkg}/${name}`;
}

function sortedUnique(values: readonly string[]): string[] {
	return [...new Set(values)].sort();
}

/** Declared dependency names from one manifest section value; malformed sections contribute nothing. */
function dependencyNames(sectionValue: unknown): string[] {
	if (typeof sectionValue !== "object" || sectionValue === null || Array.isArray(sectionValue)) {
		return [];
	}
	return sortedUnique(Object.keys(sectionValue));
}

/** Declared entry roots from the simple string fields and `bin` (string or map). */
function declaredEntryRoots(manifest: Record<string, unknown>): string[] {
	const entries: string[] = [];
	for (const field of ENTRY_FIELDS) {
		const value = manifest[field];
		if (typeof value === "string") entries.push(value);
	}
	const bin = manifest.bin;
	if (typeof bin === "string") entries.push(bin);
	else if (typeof bin === "object" && bin !== null) {
		for (const value of Object.values(bin)) {
			if (typeof value === "string") entries.push(value);
		}
	}
	return sortedUnique(entries);
}

/**
 * Read one package manifest, recording its bytes for staging and reporting
 * interpretation issues instead of throwing. Returns the interpreted manifest
 * object, or `undefined` when it was unreadable or malformed.
 */
async function readManifest(
	root: string,
	pkg: string,
	files: ContextRead[],
	readFailures: ContextReadFailure[],
	issues: ContextIssue[],
): Promise<Record<string, unknown> | undefined> {
	const manifestPath = toPackageRelative(pkg, "package.json");
	const manifestRead = await readFile(join(root, manifestPath)).then(
		(bytes) => ({ ok: true as const, bytes }),
		(error: unknown) => ({ ok: false as const, reason: messageOf(error) }),
	);
	if (!manifestRead.ok) {
		readFailures.push({ path: manifestPath, reason: manifestRead.reason });
		return undefined;
	}
	files.push({
		path: manifestPath,
		role: "manifest",
		bytes: manifestRead.bytes,
		sha256: sha256Hex(manifestRead.bytes),
	});
	try {
		const parsed: unknown = JSON.parse(new TextDecoder().decode(manifestRead.bytes));
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		issues.push({ path: manifestPath, reason: "manifest is valid JSON but not an object" });
	} catch (error) {
		issues.push({ path: manifestPath, reason: `manifest is not valid JSON (${messageOf(error)})` });
	}
	return undefined;
}

/** Read every root-level tsconfig file of one package directory. */
async function readTsconfigs(
	root: string,
	pkg: string,
	dir: string,
	files: ContextRead[],
	readFailures: ContextReadFailure[],
): Promise<void> {
	const listing = await readdir(dir).then(
		(names) => ({ ok: true as const, names }),
		(error: unknown) => ({ ok: false as const, reason: messageOf(error) }),
	);
	if (!listing.ok) {
		readFailures.push({ path: pkg, reason: `package directory not listable (${listing.reason})` });
		return;
	}
	for (const name of [...listing.names].sort()) {
		if (!isTsconfigName(name)) continue;
		const tsconfigPath = toPackageRelative(pkg, name);
		const tsconfigRead = await readFile(join(root, tsconfigPath)).then(
			(bytes) => ({ ok: true as const, bytes }),
			(error: unknown) => ({ ok: false as const, reason: messageOf(error) }),
		);
		if (!tsconfigRead.ok) {
			readFailures.push({ path: tsconfigPath, reason: tsconfigRead.reason });
		} else {
			files.push({
				path: tsconfigPath,
				role: "tsconfig",
				bytes: tsconfigRead.bytes,
				sha256: sha256Hex(tsconfigRead.bytes),
			});
		}
	}
}

/** Declarations one interpreted manifest contributes. */
function manifestDeclarations(
	pkg: string,
	manifest: Record<string, unknown>,
): { dependencies: DependencyDeclarations; entryRoots: DeclaredEntries } {
	const sections = {} as Record<DependencySection, string[]>;
	for (const section of DEPENDENCY_SECTIONS) {
		sections[section] = dependencyNames(manifest[section]);
	}
	return {
		dependencies: { packagePath: pkg, sections },
		entryRoots: { packagePath: pkg, entries: declaredEntryRoots(manifest) },
	};
}

/**
 * Enumerate the declarative context of `packageRoots` (repo-relative, `.` for
 * the root package) under the absolute `root`. Pure enumeration plus reads —
 * no execution, no network, no writes; the staging layer owns staging the
 * returned bytes.
 */
export async function enumerateProjectContext(
	root: string,
	packageRoots: readonly string[],
): Promise<ProjectContext> {
	const files: ContextRead[] = [];
	const readFailures: ContextReadFailure[] = [];
	const issues: ContextIssue[] = [];
	const dependencies: DependencyDeclarations[] = [];
	const entryRoots: DeclaredEntries[] = [];

	for (const pkg of [...new Set(packageRoots)].sort(byRelativePath)) {
		const manifest = await readManifest(root, pkg, files, readFailures, issues);
		await readTsconfigs(root, pkg, pkg === "." ? root : join(root, pkg), files, readFailures);
		if (manifest !== undefined) {
			const declarations = manifestDeclarations(pkg, manifest);
			dependencies.push(declarations.dependencies);
			entryRoots.push(declarations.entryRoots);
		}
	}

	return {
		files: files.sort((a, b) => byRelativePath(a.path, b.path)),
		readFailures: readFailures.sort((a, b) => byRelativePath(a.path, b.path)),
		issues: issues.sort((a, b) => byRelativePath(a.path, b.path)),
		dependencies: dependencies.sort((a, b) => byRelativePath(a.packagePath, b.packagePath)),
		entryRoots: entryRoots.sort((a, b) => byRelativePath(a.packagePath, b.packagePath)),
	};
}
