/**
 * Pure Knip-context preparation (plan `pl-43c5` step 23, trellis-5da5) —
 * resolving the compiled reachability policy
 * (`./policy.ts`, from `src/contract/reachability-policy.ts`) against the
 * audit's measured selection into one deterministic {@link
 * PreparedReachabilityContext}. No Knip invocation, no process, no I/O:
 * step 24 (trellis-8ebc) owns the adapter that executes over this context.
 *
 * The context is the declared reachability model the research record
 * demands (docs/research/architecture-provider-spike): local non-use
 * never means unnecessary code, so every declared root is resolved and
 * every unresolved declaration becomes a recorded contextual assumption
 * (AC3) — never a dropped key, never a confirmed-dead-code claim.
 *
 * Invariants the preparation enforces:
 *
 * - **Reuse, never reinvent, the production/test classification (AC2).**
 *   The input is the audit's measured selection — the same classified
 *   files the native analyzers and the other provider adapters select
 *   (`measuredSelection` in `src/audit/providers.ts` over
 *   `MEASURED_SOURCE_SETS`). Production files are the project scope;
 *   test files are a separate set. Test participation — wholesale via
 *   the `roots` mode or per-file via a declared test entry — adds
 *   **test roots** that supply reachability evidence while staying
 *   classified `test`: never production members, never in the
 *   production project-file denominator.
 * - **A public surface is the declared file (AC5).** A barrel's
 *   re-export is the barrel's surface, at the barrel's path; the
 *   implementation files it exposes are ordinary project files, and the
 *   preparation never expands re-exports — a surface record can never be
 *   rewritten to the implementation it exposes, in either direction.
 * - **Omitted and unresolvable declarations are assumptions (AC3).** A
 *   declared entry or surface absent from the measured selection, or a
 *   surface resolving to a non-production file, is recorded with its
 *   paths under the closed assumption vocabulary — undefined
 *   reachability, never dead code.
 */
import type {
	ProviderOptions,
	ReachabilityPublicSurface,
	ReachabilityTestMode,
	SourceSet,
} from "../../contract/index.ts";
import type { CompiledReachabilityPolicy, ReachabilityAssumption } from "./policy.ts";

/**
 * One file of the measured selection — the minimal structural shape the
 * preparation consumes. Both `ClassifiedFile` (`src/discovery/`) and
 * `StagedSelectionFile` (`src/providers/staging.ts`) satisfy it, so the
 * preparation runs over exactly the files the audit already selected and
 * classified.
 */
export interface ReachabilitySelectionFile {
	/** Repo-relative POSIX path. */
	path: string;
	/** The source set the audit's classification assigned (production, test, …). */
	sourceSet: SourceSet;
}

/**
 * The prepared reachability context: the resolved root sets, the selected
 * project scope, and the recorded contextual assumptions — one canonical
 * input for the step-24 adapter, whose tool config, coverage and evidence
 * derive from it. All collections are sorted; roots and scope never
 * overlap across the production/test boundary.
 */
export interface PreparedReachabilityContext {
	/** The declarative subset's version — carried from the compiled policy. */
	version: number;
	/** The compiled policy's digest — the normalized configuration identity. */
	digest: string;
	/** The §16.2 provider-options identity fragment — carried unchanged from the compiled policy. */
	identityOptions: ProviderOptions;
	/** Plugin discovery is always disabled (AC4) — carried from the compiled policy. */
	pluginDiscovery: "disabled";
	/** The test-participation mode in effect. */
	testMode: ReachabilityTestMode;
	/** Resolved production entry roots — application/script files where execution starts. */
	entryRoots: readonly string[];
	/**
	 * Test roots supplying reachability evidence: every measured test file
	 * when the mode is `roots`, plus any declared entry resolving to a test
	 * file (an explicit per-file opt-in). Never production members.
	 */
	testRoots: readonly string[];
	/**
	 * Declared public surfaces resolved to production files, in the
	 * compiled policy's canonical order. A surface is the declared file —
	 * the implementation files a barrel exposes are ordinary project
	 * files, never implied public or reachable by the declaration.
	 */
	publicSurfaces: readonly ReachabilityPublicSurface[];
	/**
	 * The selected production project files — the candidate scope. Always
	 * excludes every test file, whatever the test mode (AC2: participation
	 * never dilutes production denominators).
	 */
	projectFiles: readonly string[];
	/** The measured test files in scope — evidence suppliers when participating. */
	testFiles: readonly string[];
	/**
	 * The recorded contextual assumptions, sorted by id: the compiled
	 * policy's declaration-level assumptions plus the resolution-level
	 * gaps found against this selection. Every one records undefined
	 * reachability — none can imply confirmed dead code (AC3).
	 */
	assumptions: readonly ReachabilityAssumption[];
}

/** The sorted unique union of two already-sorted path lists. */
function mergeSortedUnique(a: readonly string[], b: readonly string[]): string[] {
	const merged = [...new Set([...a, ...b])];
	return merged.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
}

/** Sort paths ascending. */
function byPath(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Split the measured selection into its sorted production/test path sets. */
function scopeSets(sourceSets: ReadonlyMap<string, SourceSet>): {
	projectFiles: string[];
	testFiles: string[];
} {
	const projectFiles: string[] = [];
	const testFiles: string[] = [];
	for (const [path, sourceSet] of sourceSets) {
		if (sourceSet === "production") projectFiles.push(path);
		else if (sourceSet === "test") testFiles.push(path);
	}
	projectFiles.sort(byPath);
	testFiles.sort(byPath);
	return { projectFiles, testFiles };
}

/** Resolve the declared entries against the selection, per classification. */
function resolveEntries(
	policy: CompiledReachabilityPolicy,
	sourceSets: ReadonlyMap<string, SourceSet>,
) {
	const entryRoots: string[] = [];
	const declaredTestEntries: string[] = [];
	const missingEntries: string[] = [];
	for (const path of policy.entries) {
		const sourceSet = sourceSets.get(path);
		if (sourceSet === "production") entryRoots.push(path);
		else if (sourceSet === "test") declaredTestEntries.push(path);
		else missingEntries.push(path);
	}
	return { entryRoots, declaredTestEntries, missingEntries };
}

/** Resolve the declared public surfaces against the selection (AC5: the declared file is the surface). */
function resolvePublicSurfaces(
	policy: CompiledReachabilityPolicy,
	sourceSets: ReadonlyMap<string, SourceSet>,
) {
	const publicSurfaces: ReachabilityPublicSurface[] = [];
	const missingSurfaces: string[] = [];
	const nonProductionSurfaces: string[] = [];
	for (const surface of policy.publicSurfaces) {
		const sourceSet = sourceSets.get(surface.path);
		if (sourceSet === "production") publicSurfaces.push(surface);
		else if (sourceSet === undefined) missingSurfaces.push(surface.path);
		else nonProductionSurfaces.push(surface.path);
	}
	return { publicSurfaces, missingSurfaces, nonProductionSurfaces };
}

/** Merge declaration-level and resolution-level assumptions into one sorted record set. */
function collectAssumptions(
	policy: CompiledReachabilityPolicy,
	gaps: {
		missingEntries: readonly string[];
		missingSurfaces: readonly string[];
		nonProductionSurfaces: readonly string[];
	},
	testFiles: readonly string[],
): ReachabilityAssumption[] {
	const assumptions: ReachabilityAssumption[] = [...policy.assumptions];
	if (gaps.missingEntries.length > 0) {
		assumptions.push({
			id: "declared-entry-not-in-selection",
			paths: mergeSortedUnique(gaps.missingEntries, []),
		});
	}
	if (gaps.missingSurfaces.length > 0) {
		assumptions.push({
			id: "declared-public-surface-not-in-selection",
			paths: mergeSortedUnique(gaps.missingSurfaces, []),
		});
	}
	if (gaps.nonProductionSurfaces.length > 0) {
		assumptions.push({
			id: "public-surface-not-production",
			paths: mergeSortedUnique(gaps.nonProductionSurfaces, []),
		});
	}
	if (policy.testMode === "excluded" && testFiles.length > 0) {
		assumptions.push({ id: "tests-excluded", paths: [] });
	}
	assumptions.push({ id: "dependency-context-unverified", paths: [] });
	return assumptions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Prepare the reachability context: resolve the compiled policy's declared
 * entries and public surfaces against the measured selection. Pure and
 * deterministic: the selection is indexed by path (duplicates collapse),
 * production files become the project scope, declared entries become
 * roots in their own classification (production entries, test entries),
 * and every declaration that cannot resolve to a measured production file
 * becomes a recorded assumption with its paths — never a dropped key and
 * never a dead-code claim.
 */
export function prepareReachabilityContext(
	policy: CompiledReachabilityPolicy,
	selection: readonly ReachabilitySelectionFile[],
): PreparedReachabilityContext {
	const sourceSets = new Map<string, SourceSet>();
	for (const file of selection) sourceSets.set(file.path, file.sourceSet);
	const { projectFiles, testFiles } = scopeSets(sourceSets);
	const { entryRoots, declaredTestEntries, missingEntries } = resolveEntries(policy, sourceSets);
	const { publicSurfaces, missingSurfaces, nonProductionSurfaces } = resolvePublicSurfaces(
		policy,
		sourceSets,
	);
	const testRoots = mergeSortedUnique(
		policy.testMode === "roots" ? testFiles : [],
		declaredTestEntries,
	);
	return {
		version: policy.version,
		digest: policy.digest,
		identityOptions: policy.identityOptions,
		pluginDiscovery: policy.pluginDiscovery,
		testMode: policy.testMode,
		entryRoots,
		testRoots,
		publicSurfaces,
		projectFiles,
		testFiles,
		assumptions: collectAssumptions(
			policy,
			{ missingEntries, missingSurfaces, nonProductionSurfaces },
			testFiles,
		),
	};
}
