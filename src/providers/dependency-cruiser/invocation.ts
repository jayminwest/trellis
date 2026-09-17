/**
 * Pinned dependency-cruiser invocation identity and asset resolution (SPEC
 * §16.2/§16.4, plan `pl-43c5` step 22 — trellis-adbf).
 *
 * The pinned distribution is **pure JavaScript**: the artifact is a
 * launcher script (`bin/dependency-cruiser.mjs`), so the adapter executes
 * it through trellis's own runtime executable — the only interpreter the
 * controlled process runner already supports (`../process.ts`) — with the
 * launcher path as an inert first argument. The launcher itself is a
 * pinned, digest-verified artifact of the manifest/resolver
 * (`../manifest.ts` + `../resolve.ts`); nothing is resolved from PATH,
 * `bunx`, or the target.
 *
 * Identity (§16.2): provider identity records the invocation mode and the
 * compiled policy's normalized identity fragment (version, rule count,
 * digest — from `./policy.ts`), so a changed declared architecture is a
 * changed analysis, never silently diffed evidence. Analysis identity
 * additionally records the **parser context the tool actually resolved**:
 * dependency-cruiser reads TypeScript through the TypeScript compiler it
 * finds locally, and the research record shows a missing or mismatched
 * parser produces a successful empty graph — so the adapter resolves and
 * records that compiler's version up front and refuses to run blind.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
	AnalysisIdentity,
	AnalysisResult,
	ProviderIdentity,
	ProviderOptions,
	SourceSelection,
} from "../../contract/index.ts";
import { pinnedTool } from "../manifest.ts";
import { pinnedExecutable, type ResolvedExecutable, resolveExecutable } from "../process.ts";
import type { PinnedToolResolution, PinnedToolResolveOptions } from "../resolve.ts";
import type { StagedWorkspaceView } from "../workspace.ts";
import type { CompiledArchitecturePolicy } from "./policy.ts";
import {
	DEPENDENCY_CRUISER_ADAPTER_VERSION,
	DEPENDENCY_CRUISER_MODE,
	DEPENDENCY_CRUISER_PARSER_ENGINE,
	DEPENDENCY_CRUISER_PROVIDER_ID,
} from "./raw.ts";

/** Operational error (SPEC §16.3): the dependency-cruiser request or selection is invalid. */
export class InvalidDependencyCruiserRequestError extends Error {
	constructor(reason: string) {
		super(`invalid dependency-cruiser request: ${reason}`);
		this.name = "InvalidDependencyCruiserRequestError";
	}
}

/** Default execution limits per dependency-cruiser process (bounded, generous for real workspaces). */
export const DEPENDENCY_CRUISER_DEFAULT_TIMEOUT_MS = 60_000;
export const DEPENDENCY_CRUISER_DEFAULT_MAX_OUTPUT_BYTES = 4_000_000;

/** One adapter request: the execution limits to run the single declared-rules cruise under. */
export interface DependencyCruiserRequest {
	/** Wall-time limit per process run in milliseconds. */
	timeoutMs?: number;
	/** Output limit per stream in bytes. */
	maxOutputBytes?: number;
	/** Cancellation handle, propagated to the provider process. */
	signal?: AbortSignal;
	/** Pinned-tool resolution options (test seam for located resolution failures). */
	resolve?: PinnedToolResolveOptions;
}

/** Validate one positive-integer execution limit with its default. */
function normalizeLimit(name: string, value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new InvalidDependencyCruiserRequestError(`${name} must be a positive integer`);
	}
	return value;
}

/** Normalize the request shape (operational validation, SPEC §16.3). */
export function normalizeDependencyCruiserRequest(request: DependencyCruiserRequest = {}): {
	timeoutMs: number;
	maxOutputBytes: number;
	signal: AbortSignal | undefined;
	resolve: PinnedToolResolveOptions;
} {
	const { signal } = request;
	if (signal !== undefined && (typeof signal !== "object" || signal === null)) {
		throw new InvalidDependencyCruiserRequestError("signal must be an AbortSignal");
	}
	return {
		timeoutMs: normalizeLimit(
			"timeoutMs",
			request.timeoutMs,
			DEPENDENCY_CRUISER_DEFAULT_TIMEOUT_MS,
		),
		maxOutputBytes: normalizeLimit(
			"maxOutputBytes",
			request.maxOutputBytes,
			DEPENDENCY_CRUISER_DEFAULT_MAX_OUTPUT_BYTES,
		),
		signal,
		resolve: request.resolve ?? {},
	};
}

/** The manifest entry of the pinned tool (module-load invariant: it exists). */
function pinnedEntry() {
	const entry = pinnedTool(DEPENDENCY_CRUISER_PROVIDER_ID);
	if (entry === undefined) {
		throw new Error(`no pinned tool manifest entry for "${DEPENDENCY_CRUISER_PROVIDER_ID}"`);
	}
	return entry;
}

/** The pinned dependency-cruiser tool version (provider identity, SPEC §16.2). */
export function dependencyCruiserPinnedToolVersion(): string {
	return pinnedEntry().pinnedVersion;
}

/** The exact `--version` stdout the pinned tool must report (verified at invocation). */
export function expectedDependencyCruiserVersionOutput(): string {
	return pinnedEntry().versionOutput;
}

/**
 * The TypeScript compiler the pinned tool resolves locally: the research
 * record (docs/research/architecture-provider-spike) shows
 * dependency-cruiser exits **successfully with an empty graph** when its
 * parser is missing, and that its parser need not match trellis's own —
 * so the adapter resolves the compiler the tool will find (the
 * `node_modules` chain upward from the pinned package) and records its
 * version. Never assumed, never invented: an unresolvable compiler is a
 * located `unavailable` outcome, and its version rides the analysis
 * identity so incompatible parser pairs never compare equal (§16.6).
 */
export function resolveDependencyCruiserTypescript(
	resolution: Extract<PinnedToolResolution, { state: "available" }>,
): { version: string } | { state: "unavailable"; reason: string } {
	const launcherDir = dirname(resolution.executablePath);
	const packageRoot = dirname(launcherDir);
	let current = packageRoot;
	while (true) {
		const manifestPath = join(current, "node_modules", "typescript", "package.json");
		if (existsSync(manifestPath)) {
			try {
				const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
					name?: unknown;
					version?: unknown;
				};
				if (manifest.name === "typescript" && typeof manifest.version === "string") {
					return { version: manifest.version };
				}
			} catch {
				// A malformed package.json keeps walking upward.
			}
		}
		const parent = dirname(current);
		if (parent === current) {
			return {
				state: "unavailable",
				reason:
					"the pinned dependency-cruiser resolves no local TypeScript compiler — without one it " +
					"exits successfully with an empty graph (the research record), so the analysis would " +
					"fabricate coverage; prepare a local typescript installation in the pinned tool's " +
					"resolution chain (e.g. `bun install` where trellis resolves from)",
			};
		}
		current = parent;
	}
}

/**
 * The invocation of the pinned pure-JavaScript launcher: the interpreter is
 * trellis's own runtime (the controlled runner's supported `bun`
 * executable), the launcher the digest-verified pinned artifact — never a
 * PATH lookup, never a target-provided command string.
 */
export function pinnedLauncherInvocation(
	resolution: Extract<PinnedToolResolution, { state: "available" }>,
): { interpreter: ResolvedExecutable; launcher: ResolvedExecutable; args: readonly string[] } {
	return {
		interpreter: resolveExecutable("bun"),
		launcher: pinnedExecutable(DEPENDENCY_CRUISER_PROVIDER_ID, resolution.executablePath),
		args: [resolution.executablePath],
	};
}

/** The trellis-owned option set a cruise applies (recorded in identity, §16.2). */
export function dependencyCruiserProviderOptions(
	policy: CompiledArchitecturePolicy,
): ProviderOptions {
	return {
		...policy.identityOptions,
		"ts-pre-compilation-deps": true,
		"do-not-follow": "node_modules",
		extensions: ".ts,.tsx,.js,.json",
		"condition-names": "import,require,node,default",
		"ts-config": "generated-minimal",
		"output-type": "json",
	};
}

/**
 * The minimal explicit environment one invocation runs under: exactly one
 * trellis-owned home directory (inside the owned scratch), nothing
 * inherited. The pinned tool resolves its global configuration through
 * the home directory (`global-directory` reads `~/.npmrc` — and fails
 * outright without a home), so an owned empty home both satisfies it and
 * keeps operator ambient configuration out of the measurement (§16.4).
 */
export function dependencyCruiserEnvironment(homeDir: string): Record<string, string> {
	return { HOME: homeDir, USERPROFILE: homeDir };
}

/** The provider identity of one cruise (§16.2). */
export function dependencyCruiserProviderIdentity(
	policy: CompiledArchitecturePolicy,
): ProviderIdentity {
	return {
		kind: "external",
		id: DEPENDENCY_CRUISER_PROVIDER_ID,
		toolVersion: dependencyCruiserPinnedToolVersion(),
		adapterVersion: DEPENDENCY_CRUISER_ADAPTER_VERSION,
		mode: DEPENDENCY_CRUISER_MODE,
		options: dependencyCruiserProviderOptions(policy),
	};
}

/** The staged view's source selection (§16.2 analysis-identity input), unique and sorted. */
export function sourceSelectionFromStagedView(
	view: StagedWorkspaceView,
): SourceSelection | undefined {
	if (view.files.length === 0) return undefined;
	return {
		sourceSets: [...new Set(view.files.map((file) => file.sourceSet))].sort(),
		files: view.files
			.map((file) => ({ path: file.path, fingerprint: file.sha256 }))
			.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
	};
}

/** The analysis identity of one cruise: staged selection, the tool's resolved parser, the declarative options (§16.2). */
export function dependencyCruiserAnalysisIdentity(
	view: StagedWorkspaceView,
	policy: CompiledArchitecturePolicy,
	parserVersion: string,
): AnalysisIdentity | undefined {
	const selection = sourceSelectionFromStagedView(view);
	if (selection === undefined) return undefined;
	return {
		selection,
		parser: { engine: DEPENDENCY_CRUISER_PARSER_ENGINE, version: parserVersion },
		options: dependencyCruiserProviderOptions(policy),
	};
}

/** A located `unavailable`/`unsupported` result for a request that never executed. */
export function neverRan(
	policy: CompiledArchitecturePolicy,
	state: "unavailable" | "unsupported",
	reason: string,
): AnalysisResult {
	return { provider: dependencyCruiserProviderIdentity(policy), state, reason };
}
