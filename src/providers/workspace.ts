/**
 * The isolated staged source view for explicitly enabled providers (SPEC
 * §16.4, plan `pl-43c5` — trellis-2fe6). {@link stageWorkspaceView}
 * snapshots **selected** TS/TSX source — a discovery-inventory projection —
 * into a uniquely owned temporary directory, so an external analysis
 * consumes a frozen, explicitly classified copy of the workspace, never the
 * live dirty worktree. Native default execution never invokes this layer;
 * only provider adapters (through their `staged-run` lifecycle) opt in.
 *
 * - **Snapshot, not a live view.** Bytes and SHA-256 fingerprints are
 *   captured at staging time; {@link StagedWorkspaceView.detectDrift}
 *   re-checks the target afterwards so native and provider evidence can
 *   never silently analyze different content (§16.2 analysis identity).
 *   Read failures and drift are reported explicitly — never dropped.
 * - **Boundaries and package-relative paths preserved.** Every staged file
 *   keeps its source-set classification and owning package, and staged
 *   copies keep their repo-relative layout.
 * - **No undisclosed inclusion.** Selection paths must be repo-relative, and
 *   every file is realpath-validated to stay inside the audited root, so
 *   symlink- and traversal-based escapes are rejected and reported, never
 *   staged. Exposed paths (root, scratch, staged) are canonicalized — the
 *   macOS `/var` ↔ `/private/var` alias finding — so aliases cannot reach
 *   provider inputs.
 * - **Source-only by default.** `mode: "project-aware"` opts in to narrowly
 *   enumerated declarative context (`context.ts`: manifests, tsconfigs,
 *   dependency names, entry roots — never `node_modules` contents, never
 *   executable target configuration), with all semantics in provenance.
 * - **Owned scratch, zero target writes.** Scratch is a fresh `mkdtemp`
 *   directory *outside* the audited root (staging refuses a tmpdir inside
 *   it) holding the staged `source/` view plus a writable `work/` area.
 *   `cleanup` is idempotent and reports failures; `withStagedWorkspaceView`
 *   (staged-run.ts) guarantees cleanup on every exit path. The target
 *   workspace is only ever read.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SOURCE_SETS, type SourceSet } from "../contract/index.ts";
import {
	type ContextIssue,
	type DeclaredEntries,
	type DependencyDeclarations,
	enumerateProjectContext,
} from "./context.ts";
import {
	byRelativePath,
	type CleanupStatus,
	computeSnapshotDigest,
	containsPath,
	type DriftReport,
	makeCleanup,
	makeDetectDrift,
	messageOf,
	normalizeStagingRequest,
	type StagedContextFile,
	type StagedFile,
	type StagedSelectionFile,
	StagingError,
	type StagingMode,
	type StagingReadFailure,
	type StagingRejection,
	type StagingRequest,
	sha256Hex,
} from "./staging.ts";

/** Deterministic provenance of one staged view (feeds §16.2 analysis identity). */
export interface StagingProvenance {
	mode: StagingMode;
	/** Staged source files per source set — every set key is always present. */
	filesBySourceSet: Record<SourceSet, number>;
	/** Declarative context files staged, sorted by path (project-aware only). */
	contextFiles: { path: string; role: string }[];
	/** Declared dependency names per package (project-aware only). */
	dependencyDeclarations: DependencyDeclarations[];
	/** Declared entry roots per package (project-aware only). */
	entryRoots: DeclaredEntries[];
	/** Malformed-but-staged declarative context (project-aware only). */
	contextIssues: ContextIssue[];
	/** SHA-256 over the canonical snapshot line format (path, kind, fingerprint). */
	snapshotDigest: string;
}

/** One staged workspace view; see the module docblock for guarantees. */
export interface StagedWorkspaceView {
	/** Canonical absolute audited root. */
	root: string;
	/** Canonical absolute trellis-owned scratch directory. */
	scratchDir: string;
	/** Canonical absolute staged source root (`<scratch>/source`). */
	stagedRoot: string;
	/** Canonical absolute writable working area (`<scratch>/work`) for provider output. */
	workDir: string;
	provenance: StagingProvenance;
	/** Staged source files, sorted by path. */
	files: readonly StagedFile[];
	/** Staged context files, sorted by path (project-aware mode). */
	contextFiles: readonly StagedContextFile[];
	/** Source/context files that could not be read, sorted by path. */
	readFailures: readonly StagingReadFailure[];
	/** Selections refused for escaping the audited root, sorted by path. */
	rejected: readonly StagingRejection[];
	/** Re-check the target against the snapshot fingerprints; works after cleanup. */
	detectDrift(): Promise<DriftReport>;
	/** Remove the owned scratch directory (idempotent; failures reported, not thrown). */
	cleanup(): Promise<CleanupStatus>;
}

/** Resolve the audited root to a canonical existing directory. */
async function resolveAuditedRoot(root: string): Promise<string> {
	let rootReal: string;
	try {
		rootReal = await realpath(resolve(root));
	} catch (error) {
		throw new StagingError(
			`could not resolve audited root ${JSON.stringify(root)} (${messageOf(error)})`,
		);
	}
	if (!(await stat(rootReal)).isDirectory()) {
		throw new StagingError(`audited root ${rootReal} is not a directory`);
	}
	return rootReal;
}

/** Create the uniquely owned scratch (outside the root) with its source and work areas. */
async function createScratch(
	rootReal: string,
): Promise<{ scratchDir: string; scratchReal: string; stagedRoot: string; workDir: string }> {
	const scratchDir = await mkdtemp(join(tmpdir(), "trellis-staged-"));
	try {
		const scratchReal = await realpath(scratchDir);
		if (containsPath(rootReal, scratchReal)) {
			throw new StagingError(
				`temporary directory ${scratchReal} resolves inside the audited root; refusing to stage into the target workspace`,
			);
		}
		const stagedRoot = join(scratchReal, "source");
		const workDir = join(scratchReal, "work");
		await mkdir(stagedRoot, { recursive: true });
		await mkdir(workDir, { recursive: true });
		return { scratchDir, scratchReal, stagedRoot, workDir };
	} catch (error) {
		// The caller cannot know this dir yet — clean the refused scratch here.
		await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
}

/** Write one staged copy, creating parent directories under the staged root. */
async function writeStagedCopy(
	stagedRoot: string,
	path: string,
	bytes: Uint8Array,
): Promise<string> {
	const stagedPath = join(stagedRoot, path);
	await mkdir(dirname(stagedPath), { recursive: true });
	await writeFile(stagedPath, bytes);
	return stagedPath;
}

/** Snapshot the selection: bytes, fingerprints, boundaries — escapes refused, failures reported. */
async function snapshotSelection(
	rootReal: string,
	stagedRoot: string,
	selection: readonly StagedSelectionFile[],
): Promise<{
	stagedFiles: StagedFile[];
	readFailures: StagingReadFailure[];
	rejected: StagingRejection[];
}> {
	const stagedFiles: StagedFile[] = [];
	const readFailures: StagingReadFailure[] = [];
	const rejected: StagingRejection[] = [];
	for (const entry of selection) {
		const realFile = await realpath(join(rootReal, entry.path)).then(
			(path) => ({ ok: true as const, path }),
			(error: unknown) => ({ ok: false as const, reason: messageOf(error) }),
		);
		if (!realFile.ok) {
			readFailures.push({ path: entry.path, reason: `could not be resolved (${realFile.reason})` });
			continue;
		}
		if (!containsPath(rootReal, realFile.path)) {
			rejected.push({
				path: entry.path,
				reason: "resolves outside the audited root (symlink or traversal escape)",
			});
			continue;
		}
		const bytes = await readFile(realFile.path).then(
			(content) => ({ ok: true as const, content }),
			(error: unknown) => ({ ok: false as const, reason: messageOf(error) }),
		);
		if (!bytes.ok) {
			readFailures.push({ path: entry.path, reason: `could not be read (${bytes.reason})` });
			continue;
		}
		stagedFiles.push({
			path: entry.path,
			stagedPath: await writeStagedCopy(stagedRoot, entry.path, bytes.content),
			sourceSet: entry.sourceSet,
			packagePath: entry.packagePath,
			sha256: sha256Hex(bytes.content),
			bytes: bytes.content.byteLength,
		});
	}
	return { stagedFiles, readFailures, rejected };
}

/** Build the deterministic provenance record of a staged view. */
function buildProvenance(
	mode: StagingMode,
	stagedFiles: readonly StagedFile[],
	contextFiles: readonly StagedContextFile[],
	context: {
		dependencyDeclarations: DependencyDeclarations[];
		entryRoots: DeclaredEntries[];
		contextIssues: ContextIssue[];
	},
): StagingProvenance {
	const filesBySourceSet = {} as Record<SourceSet, number>;
	for (const set of SOURCE_SETS) filesBySourceSet[set] = 0;
	for (const file of stagedFiles) filesBySourceSet[file.sourceSet] += 1;
	return {
		mode,
		filesBySourceSet,
		contextFiles: contextFiles.map((file) => ({ path: file.path, role: file.role })),
		dependencyDeclarations: context.dependencyDeclarations,
		entryRoots: context.entryRoots,
		contextIssues: context.contextIssues,
		snapshotDigest: computeSnapshotDigest([
			...stagedFiles.map((file) => ({
				path: file.path,
				kind: file.sourceSet,
				sha256: file.sha256,
			})),
			...contextFiles.map((file) => ({ path: file.path, kind: file.role, sha256: file.sha256 })),
		]),
	};
}

/**
 * Stage the isolated source view for one provider analysis (see the module
 * docblock for the enforced guarantees). Resolves with the view on success —
 * including when individual selections are unreadable or rejected (those are
 * reported in the view) — and rejects with {@link InvalidStagingRequestError}
 * or {@link StagingError} (operational errors, SPEC §16.3) when the request is
 * malformed or the view cannot be prepared at all.
 */
export async function stageWorkspaceView(request: StagingRequest): Promise<StagedWorkspaceView> {
	const { root, files: selection, packageRoots, mode } = normalizeStagingRequest(request);

	let scratchDir: string | undefined;
	try {
		const rootReal = await resolveAuditedRoot(root);
		const scratch = await createScratch(rootReal);
		scratchDir = scratch.scratchDir;

		const snapshot = await snapshotSelection(rootReal, scratch.stagedRoot, selection);
		const stagedFiles = snapshot.stagedFiles;

		const contextFiles: StagedContextFile[] = [];
		const context = {
			dependencyDeclarations: [] as DependencyDeclarations[],
			entryRoots: [] as DeclaredEntries[],
			contextIssues: [] as ContextIssue[],
		};
		if (mode === "project-aware") {
			const enumerated = await enumerateProjectContext(rootReal, packageRoots);
			for (const contextFile of enumerated.files) {
				contextFiles.push({
					path: contextFile.path,
					stagedPath: await writeStagedCopy(
						scratch.stagedRoot,
						contextFile.path,
						contextFile.bytes,
					),
					role: contextFile.role,
					sha256: contextFile.sha256,
					bytes: contextFile.bytes.byteLength,
				});
			}
			snapshot.readFailures.push(...enumerated.readFailures);
			context.dependencyDeclarations = enumerated.dependencies;
			context.entryRoots = enumerated.entryRoots;
			context.contextIssues = enumerated.issues;
		}

		return {
			root: rootReal,
			scratchDir: scratch.scratchReal,
			stagedRoot: scratch.stagedRoot,
			workDir: scratch.workDir,
			provenance: buildProvenance(mode, stagedFiles, contextFiles, context),
			files: stagedFiles,
			contextFiles,
			readFailures: snapshot.readFailures.sort((a, b) => byRelativePath(a.path, b.path)),
			rejected: snapshot.rejected.sort((a, b) => byRelativePath(a.path, b.path)),
			detectDrift: makeDetectDrift(rootReal, stagedFiles, contextFiles),
			cleanup: makeCleanup(scratch.scratchReal),
		};
	} catch (error) {
		if (scratchDir !== undefined) {
			await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
		}
		if (error instanceof StagingError) {
			throw error;
		}
		throw new StagingError(messageOf(error));
	}
}
