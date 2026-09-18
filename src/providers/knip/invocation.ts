/**
 * Pinned Knip invocation identity and asset resolution (SPEC §16.2/§16.4,
 * plan `pl-43c5` step 24 — trellis-8ebc).
 *
 * The pinned distribution is **pure JavaScript** with a dedicated Bun
 * launcher (`bin/knip-bun.js`), so the adapter executes it through
 * trellis's own runtime — the only interpreter the controlled process
 * runner supports (`../process.ts`) — with the launcher path as an inert
 * first argument. The launcher is a pinned, digest-verified artifact of the
 * manifest/resolver (`../manifest.ts` + `../resolve.ts`); nothing is
 * resolved from PATH, `bunx`, or the target.
 *
 * Identity (§16.2): provider identity records the invocation mode and the
 * compiled reachability policy's normalized identity fragment (version,
 * counts, test mode, digest — from step 23's `./policy.ts` via the prepared
 * context), so a changed declared reachability model is a changed analysis,
 * never silently diffed evidence. Analysis identity additionally records
 * the **parser the tool actually resolves**: Knip reads source through its
 * own bundled `oxc-parser`, whose exact version rides the install (a range
 * in Knip's manifest) — the adapter resolves and records it up front and
 * refuses to run blind, mirroring the dependency-cruiser parser discipline.
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
import type { PreparedReachabilityContext } from "./context.ts";
import {
	KNIP_ADAPTER_VERSION,
	KNIP_INCLUDE,
	KNIP_MODE,
	KNIP_PARSER_ENGINE,
	KNIP_PROVIDER_ID,
} from "./raw.ts";

/** Operational error (SPEC §16.3): the knip request or execution limits are invalid. */
export class InvalidKnipRequestError extends Error {
	constructor(reason: string) {
		super(`invalid knip request: ${reason}`);
		this.name = "InvalidKnipRequestError";
	}
}

/** Default execution limits per knip process (bounded, generous for real workspaces). */
export const KNIP_DEFAULT_TIMEOUT_MS = 60_000;
export const KNIP_DEFAULT_MAX_OUTPUT_BYTES = 4_000_000;

/** One adapter request: the execution limits to run the single reachability pass under. */
export interface KnipRequest {
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
		throw new InvalidKnipRequestError(`${name} must be a positive integer`);
	}
	return value;
}

/** Normalize the request shape (operational validation, SPEC §16.3). */
export function normalizeKnipRequest(request: KnipRequest = {}): {
	timeoutMs: number;
	maxOutputBytes: number;
	signal: AbortSignal | undefined;
	resolve: PinnedToolResolveOptions;
} {
	const { signal } = request;
	if (signal !== undefined && (typeof signal !== "object" || signal === null)) {
		throw new InvalidKnipRequestError("signal must be an AbortSignal");
	}
	return {
		timeoutMs: normalizeLimit("timeoutMs", request.timeoutMs, KNIP_DEFAULT_TIMEOUT_MS),
		maxOutputBytes: normalizeLimit(
			"maxOutputBytes",
			request.maxOutputBytes,
			KNIP_DEFAULT_MAX_OUTPUT_BYTES,
		),
		signal,
		resolve: request.resolve ?? {},
	};
}

/** The manifest entry of the pinned tool (module-load invariant: it exists). */
function pinnedEntry() {
	const entry = pinnedTool(KNIP_PROVIDER_ID);
	if (entry === undefined) {
		throw new Error(`no pinned tool manifest entry for "${KNIP_PROVIDER_ID}"`);
	}
	return entry;
}

/** The pinned knip tool version (provider identity, SPEC §16.2). */
export function knipPinnedToolVersion(): string {
	return pinnedEntry().pinnedVersion;
}

/** The exact `--version` stdout the pinned tool must report (verified at invocation). */
export function expectedKnipVersionOutput(): string {
	return pinnedEntry().versionOutput;
}

/**
 * The `oxc-parser` the pinned tool resolves locally: Knip's manifest pins a
 * range, so the exact version is a property of the operator's installation,
 * never of the pin. The adapter resolves the compiler the tool will find
 * (the `node_modules` chain upward from the pinned package) and records its
 * version on the analysis identity — an unresolvable parser is a located
 * `unavailable` outcome, never an assumed identity.
 */
export function resolveKnipParser(
	resolution: Extract<PinnedToolResolution, { state: "available" }>,
): { version: string } | { state: "unavailable"; reason: string } {
	const packageRoot = dirname(dirname(resolution.executablePath));
	let current = packageRoot;
	while (true) {
		const manifestPath = join(current, "node_modules", "oxc-parser", "package.json");
		if (existsSync(manifestPath)) {
			try {
				const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
					name?: unknown;
					version?: unknown;
				};
				if (manifest.name === "oxc-parser" && typeof manifest.version === "string") {
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
					"the pinned knip resolves no local oxc-parser — its own analysis stack is incomplete; " +
					"prepare the pinned installation where trellis resolves from (e.g. `bun install` in this " +
					"repository) so the parser identity can be recorded instead of assumed",
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
): { interpreter: ResolvedExecutable; launcher: ResolvedExecutable } {
	return {
		interpreter: resolveExecutable("bun"),
		launcher: pinnedExecutable(KNIP_PROVIDER_ID, resolution.executablePath),
	};
}

/**
 * The minimal explicit environment one invocation runs under: exactly one
 * trellis-owned home directory (inside the owned scratch), nothing
 * inherited — ambient operator configuration cannot reach the measurement
 * (§16.4).
 */
export function knipEnvironment(homeDir: string): Record<string, string> {
	return { HOME: homeDir, USERPROFILE: homeDir };
}

/** The trellis-owned option set one reachability pass applies (recorded in identity, §16.2). */
export function knipProviderOptions(context: PreparedReachabilityContext): ProviderOptions {
	return {
		...context.identityOptions,
		"resolved-entry-roots": context.entryRoots.length,
		"test-roots": context.testRoots.length,
		"project-files": context.projectFiles.length,
		"plugin-registry": "disabled",
		include: KNIP_INCLUDE,
		reporter: "json",
		gitignore: false,
		"config-hints": "errors",
	};
}

/** The provider identity of one reachability pass (§16.2). */
export function knipProviderIdentity(context: PreparedReachabilityContext): ProviderIdentity {
	return {
		kind: "external",
		id: KNIP_PROVIDER_ID,
		toolVersion: knipPinnedToolVersion(),
		adapterVersion: KNIP_ADAPTER_VERSION,
		mode: KNIP_MODE,
		options: knipProviderOptions(context),
	};
}

/** The staged view's source selection (§16.2 analysis-identity input), unique and sorted. */
export function knipSourceSelection(view: StagedWorkspaceView): SourceSelection | undefined {
	if (view.files.length === 0) return undefined;
	return {
		sourceSets: [...new Set(view.files.map((file) => file.sourceSet))].sort(),
		files: view.files
			.map((file) => ({ path: file.path, fingerprint: file.sha256 }))
			.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
	};
}

/** The analysis identity of one pass: staged selection, the tool's parser, the option set (§16.2). */
export function knipAnalysisIdentity(
	view: StagedWorkspaceView,
	context: PreparedReachabilityContext,
	parserVersion: string,
): AnalysisIdentity | undefined {
	const selection = knipSourceSelection(view);
	if (selection === undefined) return undefined;
	return {
		selection,
		parser: { engine: KNIP_PARSER_ENGINE, version: parserVersion },
		options: knipProviderOptions(context),
	};
}

/** A located `unavailable`/`unsupported` result for a request that never executed. */
export function knipNeverRan(
	context: PreparedReachabilityContext,
	state: "unavailable" | "unsupported",
	reason: string,
): AnalysisResult {
	return { provider: knipProviderIdentity(context), state, reason };
}
