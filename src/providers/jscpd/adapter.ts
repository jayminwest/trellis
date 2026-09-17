/**
 * The jscpd adapter entry point (SPEC §16.2–16.4, plan `pl-43c5` —
 * trellis-f4e2, step 12): execute the pinned tool over a **staged source
 * view** (trellis-2fe6's `../workspace.ts`) in the three pinned modes, and
 * turn its raw JSON into **validated typed evidence** before any
 * normalization (step 13, trellis-da4c, owns clone-evidence normalization
 * and line accounting — this adapter never scores, groups, or aggregates).
 *
 * `runJscpdAdapter` composes the delivered boundaries: the executable is
 * resolved and verified through the pinned-tool manifest/resolver
 * (`../manifest.ts` + `../resolve.ts`), its `--version` output is checked
 * against the pin before anything runs, and each requested mode is
 * executed by `./mode-run.ts` — started only by the controlled process
 * runner (`../process.ts`) with the fixed argv from `./invocation.ts`,
 * pointed only at the staged view, never at the target workspace.
 *
 * State mapping (§16.2, honest per mode):
 *
 * | outcome | when |
 * | --- | --- |
 * | `complete` | report validated, and jscpd's own evidence accounts for **every** staged file (its source statistics omit none) with no staging gaps |
 * | `incomplete` | the tool ran but its evidence is malformed, unexpected, or cannot assert full coverage — with located reasons; schema-valid raw evidence is still attached |
 * | `unavailable` | could not run: unresolvable/unverified pin, failed version check, exhausted execution limits, unusable scratch |
 * | `unsupported` | the host platform has no pinned binary |
 *
 * Requests are validated before anything runs — an invalid request is an
 * operational error (SPEC §16.3); every run failure is located evidence,
 * never rethrown.
 */
import { CLONE_MATCH_MODES, type CloneMatchMode } from "../../contract/index.ts";
import { pinnedTool } from "../manifest.ts";
import { pinnedExecutable, type ResolvedExecutable, runControlledProcess } from "../process.ts";
import type { PinnedToolResolveOptions } from "../resolve.ts";
import { resolvePinnedTool } from "../resolve.ts";
import type { StagedWorkspaceView } from "../workspace.ts";
import {
	InvalidJscpdRequestError,
	JSCPD_DEFAULT_THRESHOLDS,
	type JscpdThresholds,
	jscpdProviderIdentity,
	jscpdThresholdsSchema,
} from "./invocation.ts";
import { type JscpdModeOutcome, outcomeReason, runJscpdMode } from "./mode-run.ts";
import { JSCPD_ADAPTER_VERSION, JSCPD_PROVIDER_ID } from "./raw.ts";

/** Default execution limits per jscpd process (bounded, generous for real workspaces). */
const JSCPD_DEFAULT_TIMEOUT_MS = 60_000;
const JSCPD_DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

/** One adapter request: the modes to run and the limits to run them under. */
export interface JscpdRequest {
	/** Match modes to run; default: all three, in contract order. */
	modes?: readonly CloneMatchMode[];
	/** Detection thresholds; default: the pinned calibration. */
	thresholds?: JscpdThresholds;
	/** Wall-time limit per process run in milliseconds. */
	timeoutMs?: number;
	/** Output limit per stream in bytes. */
	maxOutputBytes?: number;
	/** Cancellation handle, propagated to every provider process. */
	signal?: AbortSignal;
	/** Pinned-tool resolution options (test seam for located resolution failures). */
	resolve?: PinnedToolResolveOptions;
}

interface NormalizedJscpdRequest {
	modes: CloneMatchMode[];
	thresholds: JscpdThresholds;
	timeoutMs: number;
	maxOutputBytes: number;
	signal: AbortSignal | undefined;
	resolve: PinnedToolResolveOptions;
}

/** Normalize the requested match modes: known, de-duplicated, contract order. */
function normalizeModes(requested: unknown): CloneMatchMode[] {
	if (!Array.isArray(requested) || requested.length === 0) {
		throw new InvalidJscpdRequestError("modes must be a non-empty array of match modes");
	}
	const modes: CloneMatchMode[] = [];
	for (const mode of new Set(requested)) {
		if (typeof mode !== "string" || !(CLONE_MATCH_MODES as readonly string[]).includes(mode)) {
			throw new InvalidJscpdRequestError(`unknown jscpd match mode "${String(mode)}"`);
		}
		modes.push(mode as CloneMatchMode);
	}
	return modes.sort((a, b) => CLONE_MATCH_MODES.indexOf(a) - CLONE_MATCH_MODES.indexOf(b));
}

/** Validate the thresholds against the pinned shape (invalid config is operational, §16.3). */
function normalizeThresholds(thresholds: unknown): JscpdThresholds {
	const parsed = jscpdThresholdsSchema.safeParse(thresholds ?? JSCPD_DEFAULT_THRESHOLDS);
	if (!parsed.success) {
		throw new InvalidJscpdRequestError(
			`invalid thresholds: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
		);
	}
	return parsed.data;
}

/** Validate one positive-integer execution limit with its default. */
function normalizeLimit(name: string, value: number | undefined, fallback: number): number {
	if (value === undefined) {
		return fallback;
	}
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new InvalidJscpdRequestError(`${name} must be a positive integer`);
	}
	return value;
}

function normalizeRequest(request: JscpdRequest): NormalizedJscpdRequest {
	if (request === null || typeof request !== "object") {
		throw new InvalidJscpdRequestError("request must be an object");
	}
	const { signal } = request;
	if (signal !== undefined && (typeof signal !== "object" || signal === null)) {
		throw new InvalidJscpdRequestError("signal must be an AbortSignal");
	}
	return {
		modes: normalizeModes(request.modes ?? CLONE_MATCH_MODES),
		thresholds: normalizeThresholds(request.thresholds),
		timeoutMs: normalizeLimit("timeoutMs", request.timeoutMs, JSCPD_DEFAULT_TIMEOUT_MS),
		maxOutputBytes: normalizeLimit(
			"maxOutputBytes",
			request.maxOutputBytes,
			JSCPD_DEFAULT_MAX_OUTPUT_BYTES,
		),
		signal,
		resolve: request.resolve ?? {},
	};
}

/** The adapter result: resolution provenance plus one outcome per requested mode. */
export interface JscpdAdapterResult {
	/** The pinned tool version (manifest identity — never what a binary happened to report). */
	toolVersion: string;
	/** This adapter's version (provider identity, SPEC §16.2). */
	adapterVersion: string;
	/** How the pinned artifact resolved on this host. */
	resolution:
		| { state: "available"; platformKey: string; binaryDigestVerified: boolean }
		| { state: "unavailable" | "unsupported"; reason: string; instructions: string };
	/** One outcome per requested mode, in request order. */
	outcomes: readonly JscpdModeOutcome[];
}

/** Verify the resolved binary reports exactly the pinned version output. */
async function verifyPinnedVersion(
	executable: ResolvedExecutable,
	limits: { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal },
	expected: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const result = await runControlledProcess(executable, {
		args: ["--version"],
		env: {},
		timeoutMs: limits.timeoutMs,
		maxOutputBytes: limits.maxOutputBytes,
		signal: limits.signal,
	});
	if (result.outcome.kind !== "exited") {
		return {
			ok: false,
			reason: `pinned jscpd version check could not run (${outcomeReason(result.outcome)})`,
		};
	}
	const reported = result.stdout.trim();
	if (result.outcome.exitCode !== 0 || reported !== expected) {
		return {
			ok: false,
			reason:
				`the resolved jscpd binary is not the pinned tool: --version reported ${JSON.stringify(reported)}, ` +
				`expected ${JSON.stringify(expected)}`,
		};
	}
	return { ok: true };
}

/**
 * Run the pinned jscpd adapter over a staged view: resolve and verify the
 * pinned artifact, check its version, then execute every requested mode
 * sequentially and validate each raw report (`./mode-run.ts`). Invalid
 * requests are operational errors (SPEC §16.3); run failures are located
 * evidence, never rethrown.
 */
export async function runJscpdAdapter(
	view: StagedWorkspaceView,
	request: JscpdRequest = {},
): Promise<JscpdAdapterResult> {
	const normalized = normalizeRequest(request);
	const entry = pinnedTool(JSCPD_PROVIDER_ID);
	if (entry === undefined) {
		throw new Error(`no pinned tool manifest entry for "${JSCPD_PROVIDER_ID}"`);
	}
	const base = { toolVersion: entry.pinnedVersion, adapterVersion: JSCPD_ADAPTER_VERSION };
	if (view.files.length === 0) {
		throw new InvalidJscpdRequestError(
			"the staged selection is empty — jscpd evidence requires at least one staged file",
		);
	}

	const resolution = resolvePinnedTool(JSCPD_PROVIDER_ID, normalized.resolve);
	if (resolution.state !== "available") {
		return {
			...base,
			resolution: {
				state: resolution.state,
				reason: resolution.reason,
				instructions: resolution.instructions,
			},
			outcomes: normalized.modes.map((mode) => ({
				state: resolution.state,
				mode,
				provider: jscpdProviderIdentity(mode, normalized.thresholds),
				reason: resolution.reason,
				instructions: resolution.instructions,
			})),
		};
	}
	const executable = pinnedExecutable(JSCPD_PROVIDER_ID, resolution.executablePath);
	const limits = {
		timeoutMs: normalized.timeoutMs,
		maxOutputBytes: normalized.maxOutputBytes,
		signal: normalized.signal,
	};
	const version = await verifyPinnedVersion(executable, limits, entry.versionOutput);
	if (!version.ok) {
		return {
			...base,
			resolution: {
				state: "available",
				platformKey: resolution.platformKey,
				binaryDigestVerified: resolution.binaryDigestVerified,
			},
			outcomes: normalized.modes.map(
				(mode): JscpdModeOutcome => ({
					state: "unavailable",
					mode,
					provider: jscpdProviderIdentity(mode, normalized.thresholds),
					reason: version.reason,
				}),
			),
		};
	}

	const outcomes: JscpdModeOutcome[] = [];
	for (const mode of normalized.modes) {
		outcomes.push(
			await runJscpdMode(view, executable, mode, {
				thresholds: normalized.thresholds,
				limits,
			}),
		);
	}
	return {
		...base,
		resolution: {
			state: "available",
			platformKey: resolution.platformKey,
			binaryDigestVerified: resolution.binaryDigestVerified,
		},
		outcomes,
	};
}
