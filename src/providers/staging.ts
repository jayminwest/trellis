/**
 * Staging vocabulary for the provider scratch boundary (SPEC §16.4, plan
 * `pl-43c5` — trellis-2fe6): the primitives and request normalization every
 * staging module shares.
 *
 * - **Content fingerprints.** Every staged byte snapshot carries a SHA-256
 *   digest, so a provider analysis can be bound to exactly the bytes it
 *   consumed (analysis identity, §16.2) and later dirty-worktree drift is
 *   detectable against the snapshot — never guessed.
 * - **Path containment.** {@link containsPath} compares canonical absolute
 *   paths; the staging view uses it on **realpath-resolved** sides so a
 *   symlink- or traversal-based escape of the audited root is refused, while
 *   aliased roots (the macOS `/var` ↔ `/private/var` spike finding) do not
 *   cause false rejections.
 * - **Deterministic orderings.** `.` first, then lexicographic — selections,
 *   package roots, and digest lines all use it, so identical input always
 *   produces identical snapshots and digests.
 * - **Request normalization.** {@link normalizeStagingRequest} validates and
 *   normalizes a staging request (sorted, de-duplicated, first occurrence
 *   wins); malformed request data is operational error territory
 *   (SPEC §16.3) via {@link InvalidStagingRequestError}.
 * - **View-lifecycle closures.** {@link makeDetectDrift} and
 *   {@link makeCleanup} build the drift-check and owned-scratch-removal
 *   methods of a staged view (see `workspace.ts`): drift re-fingerprints the
 *   target against the snapshot; cleanup is idempotent and reports failures
 *   instead of throwing over the original outcome (§16.4).
 */
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { isRepoRelativePath, SOURCE_SETS, type SourceSet } from "../contract/index.ts";
import type { ContextRole } from "./context.ts";

/** Operational error (SPEC §16.3): the staging request itself is invalid. */
export class InvalidStagingRequestError extends Error {
	constructor(reason: string) {
		super(`invalid staging request: ${reason}`);
		this.name = "InvalidStagingRequestError";
	}
}

/**
 * Operational error (SPEC §16.3): staging could not be prepared at all
 * (unresolvable root, unusable scratch, failed copy). Adapters surface this
 * as located `unavailable` evidence — never as a clean result.
 */
export class StagingError extends Error {
	constructor(reason: string) {
		super(`staging failed: ${reason}`);
		this.name = "StagingError";
	}
}

/** Declarative context mode of a staged view: default is source-only (SPEC §16.4). */
export type StagingMode = "source-only" | "project-aware";

/** One selected source file: a discovery `ClassifiedFile` projection. */
export interface StagedSelectionFile {
	/** Repo-relative POSIX path of the TS/TSX file. */
	path: string;
	/** Source-set classification (SPEC §3.1), preserved into the view. */
	sourceSet: SourceSet;
	/** Repo-relative root of the owning package (`.` for the root package). */
	packagePath: string;
}

/** Request for staging a workspace view (see `workspace.ts`). */
export interface StagingRequest {
	/** Path to the audited workspace root (absolute or cwd-relative). */
	root: string;
	/** Selected classified files to snapshot, in any order; duplicates collapse. */
	files: readonly StagedSelectionFile[];
	/**
	 * Repo-relative package roots for project-aware context. Defaults to every
	 * owning package in `files` plus the root (`.`).
	 */
	packageRoots?: readonly string[];
	/** Context mode; default `source-only`. `project-aware` is explicit opt-in. */
	mode?: StagingMode;
}

/** A validated, normalized staging request: sorted, de-duplicated. */
export interface NormalizedStagingRequest {
	root: string;
	/** Selection entries, sorted by path; first occurrence wins on duplicates. */
	files: StagedSelectionFile[];
	/** Package roots, sorted, `.` first. */
	packageRoots: string[];
	mode: StagingMode;
}

/** One staged source file: a byte snapshot with fingerprint and classification. */
export interface StagedFile {
	/** Repo-relative POSIX path of the original file. */
	path: string;
	/** Canonical absolute path of the staged copy. */
	stagedPath: string;
	/** Source-set classification (SPEC §3.1) preserved into the view. */
	sourceSet: SourceSet;
	/** Repo-relative root of the owning package (`.` for the root package). */
	packagePath: string;
	/** Content fingerprint of the staged bytes. */
	sha256: string;
	/** Byte length of the staged snapshot. */
	bytes: number;
}

/** One staged declarative context file (manifest or tsconfig). */
export interface StagedContextFile {
	path: string;
	stagedPath: string;
	role: ContextRole;
	sha256: string;
	bytes: number;
}

/** A selected or context file that could not be read — reported, never dropped. */
export interface StagingReadFailure {
	path: string;
	reason: string;
}

/** A selection refused staging because it escapes the audited root. */
export interface StagingRejection {
	path: string;
	reason: string;
}

/** How one staged file drifted against its snapshot fingerprint. */
export type DriftEntry =
	| { path: string; kind: "changed"; snapshotSha256: string; currentSha256: string }
	| { path: string; kind: "unreadable"; reason: string };

/** Drift report: empty entries mean target and snapshot agree. */
export interface DriftReport {
	entries: readonly DriftEntry[];
}

/** Outcome of removing the owned scratch directory. */
export type CleanupStatus =
	| { status: "cleaned" }
	| { status: "already-clean" }
	| { status: "nothing-to-clean" }
	| { status: "failed"; reason: string };

/** SHA-256 content fingerprint, hex-encoded. */
export function sha256Hex(data: Uint8Array | string): string {
	return createHash("sha256").update(data).digest("hex");
}

/**
 * True when the canonical absolute path `child` lies strictly inside `parent`.
 * Compares resolved paths only — callers pass realpath results — so symlink
 * aliases cannot smuggle an escape past it or cause false rejections.
 */
export function containsPath(parent: string, child: string): boolean {
	if (parent === child) return false;
	const rel = relative(parent, child);
	return rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

/** Order repo-relative paths deterministically: `.` first, then lexicographic. */
export function byRelativePath(a: string, b: string): number {
	if (a === ".") return b === "." ? 0 : -1;
	if (b === ".") return 1;
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Error text for diagnostics — bounded strings, never raw throwables. */
export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** One line of the canonical snapshot digest input: what + kind + fingerprint. */
export interface SnapshotEntry {
	/** Repo-relative path of the staged file. */
	path: string;
	/** Classification or context role of the entry (source set, manifest, tsconfig). */
	kind: string;
	/** Content fingerprint of the staged bytes. */
	sha256: string;
}

/**
 * Fingerprint the whole staged snapshot: SHA-256 over the sorted canonical
 * lines `path<TAB>kind<TAB>sha256`. Two stagings of identical bytes with
 * identical classification produce the identical digest regardless of input
 * order — the anchor for §16.2 input-snapshot identity.
 */
export function computeSnapshotDigest(entries: readonly SnapshotEntry[]): string {
	const lines = entries.map((entry) => `${entry.path}\t${entry.kind}\t${entry.sha256}`).sort();
	return sha256Hex(`${lines.join("\n")}\n`);
}

/** The drift check closure: re-fingerprint the target against the snapshot. */
export function makeDetectDrift(
	rootReal: string,
	stagedFiles: readonly StagedFile[],
	contextFiles: readonly StagedContextFile[],
): () => Promise<DriftReport> {
	return async () => {
		const entries: DriftEntry[] = [];
		for (const staged of [...stagedFiles, ...contextFiles]) {
			const reread = await readFile(join(rootReal, staged.path)).then(
				(content) => ({ ok: true as const, content }),
				(error: unknown) => ({ ok: false as const, reason: messageOf(error) }),
			);
			if (!reread.ok) {
				entries.push({ path: staged.path, kind: "unreadable", reason: reread.reason });
				continue;
			}
			const currentSha256 = sha256Hex(reread.content);
			if (currentSha256 !== staged.sha256) {
				entries.push({
					path: staged.path,
					kind: "changed",
					snapshotSha256: staged.sha256,
					currentSha256,
				});
			}
		}
		return { entries: entries.sort((a, b) => byRelativePath(a.path, b.path)) };
	};
}

/** The cleanup closure: idempotent owned-scratch removal with reported failures. */
export function makeCleanup(scratchReal: string): () => Promise<CleanupStatus> {
	let scratchCleaned = false;
	return async () => {
		if (scratchCleaned) return { status: "already-clean" };
		try {
			await rm(scratchReal, { recursive: true, force: true });
			scratchCleaned = true;
			return { status: "cleaned" };
		} catch (error) {
			return { status: "failed", reason: messageOf(error) };
		}
	};
}

/** Validate one selection entry, throwing {@link InvalidStagingRequestError} on malformed data. */
function assertSelectionEntry(entry: unknown): StagedSelectionFile {
	if (entry === null || typeof entry !== "object") {
		throw new InvalidStagingRequestError("each selected file must be an object");
	}
	const { path, sourceSet, packagePath } = entry as Record<string, unknown>;
	if (
		typeof path !== "string" ||
		path === "." ||
		path.includes("\u0000") ||
		!isRepoRelativePath(path)
	) {
		throw new InvalidStagingRequestError(
			`selected file path ${JSON.stringify(path)} must be a repo-relative POSIX path`,
		);
	}
	if (typeof sourceSet !== "string" || !(SOURCE_SETS as readonly string[]).includes(sourceSet)) {
		throw new InvalidStagingRequestError(
			`selected file ${JSON.stringify(path)} has invalid sourceSet ${JSON.stringify(sourceSet)}`,
		);
	}
	if (
		typeof packagePath !== "string" ||
		packagePath.includes("\u0000") ||
		(packagePath !== "." && !isRepoRelativePath(packagePath))
	) {
		throw new InvalidStagingRequestError(
			`selected file ${JSON.stringify(path)} has invalid packagePath ${JSON.stringify(packagePath)}`,
		);
	}
	return { path, sourceSet: sourceSet as SourceSet, packagePath };
}

/** Validate, de-duplicate (first occurrence wins) and sort a selection. */
function normalizeSelectionFiles(files: unknown): StagedSelectionFile[] {
	if (!Array.isArray(files)) {
		throw new InvalidStagingRequestError("files must be an array of selection entries");
	}
	const seen = new Set<string>();
	const selection: StagedSelectionFile[] = [];
	for (const entry of files) {
		const normalized = assertSelectionEntry(entry);
		if (!seen.has(normalized.path)) {
			seen.add(normalized.path);
			selection.push(normalized);
		}
	}
	return selection.sort((a, b) => byRelativePath(a.path, b.path));
}

/** Validate and normalize the package roots (or derive them from the selection). */
function normalizePackageRoots(
	packageRoots: unknown,
	selection: readonly StagedSelectionFile[],
): string[] {
	if (packageRoots === undefined) {
		return [...new Set([".", ...selection.map((file) => file.packagePath)])].sort(byRelativePath);
	}
	if (!Array.isArray(packageRoots)) {
		throw new InvalidStagingRequestError("packageRoots must be an array of repo-relative paths");
	}
	for (const pkg of packageRoots) {
		if (typeof pkg !== "string" || pkg.includes("\u0000") || !isRepoRelativePath(pkg)) {
			throw new InvalidStagingRequestError(
				`invalid package root ${JSON.stringify(pkg)} (must be repo-relative POSIX)`,
			);
		}
	}
	return [...new Set(packageRoots)].sort(byRelativePath);
}

/**
 * Validate and normalize a staging request (see the module docblock).
 * Pure: no filesystem access — {@link InvalidStagingRequestError} is the only
 * thrown error, and nothing here distinguishes existing roots from missing
 * ones (that is `workspace.ts`'s operational territory).
 */
export function normalizeStagingRequest(request: StagingRequest): NormalizedStagingRequest {
	if (request === null || typeof request !== "object") {
		throw new InvalidStagingRequestError("request must be an object");
	}
	const { root, files, packageRoots, mode } = request as unknown as Record<string, unknown>;
	if (typeof root !== "string" || root === "" || root.includes("\u0000")) {
		throw new InvalidStagingRequestError("root must be a non-empty string without NUL");
	}
	if (mode !== undefined && mode !== "source-only" && mode !== "project-aware") {
		throw new InvalidStagingRequestError(`invalid staging mode ${JSON.stringify(mode)}`);
	}
	const selection = normalizeSelectionFiles(files);
	return {
		root,
		files: selection,
		packageRoots: normalizePackageRoots(packageRoots, selection),
		mode: mode === "project-aware" ? "project-aware" : "source-only",
	};
}
