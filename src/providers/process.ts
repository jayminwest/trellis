/**
 * The controlled process boundary for optional quality-evidence providers
 * (SPEC §16.4, plan `pl-43c5` — trellis-eddc): one reusable core call that
 * runs a **resolved supported executable** with a fixed argument array
 * under explicit limits and returns a structured result for provider
 * adapters. It enforces the SPEC §16.4 execution and trust decision:
 *
 * - **No shell, ever.** Fixed `argv` array — no `sh -c`, no joining, no
 *   interpolation. Target scripts and executable target configuration
 *   are never evaluated; target data only ever crosses as inert strings.
 * - **Supported executables only.** Executables are named through trellis-owned resolution:
 *   {@link resolveExecutable} for runtime identifiers, and pinned artifacts via the verified
 *   supported-tool manifest/resolver (`trellis-ff52`). Unsupported identifiers are operational
 *   errors (SPEC §16.3); no target- or operator-provided command path is ever accepted.
 * - **Explicit environment.** The child receives exactly the request's
 *   `env` map — nothing inherited from the trellis process, so ambient
 *   credentials cannot leak into provider execution.
 * - **Bounded execution.** Wall-time and per-stream output limits are
 *   enforced; on a limit, cancellation, or overflow the child's whole
 *   POSIX process group is terminated (no orphan descendants for the
 *   supported invocation shapes). Windows terminates only the direct
 *   child — a documented platform limitation. No portable hard RSS
 *   limit is enforced or claimed.
 * - **Raw exit codes, no success claims.** Provider-specific finding
 *   exit codes are recognized only in adapters (§16.2); process exit 0
 *   alone never marks an analysis complete.
 * - **No execution metadata.** Results carry no timestamps, process ids,
 *   or durations, so execution metadata can never enter deterministic
 *   evidence (adapters keep that discipline downstream).
 *
 * This is a controlled-execution statement, not a sandbox claim
 * (SPEC §16.4); adapters validate raw provider output before it becomes
 * evidence.
 */

import { requirePinnedToolExecutable } from "./resolve.ts";

const SENSITIVE_ENV_KEY_NAMES = [
	"token",
	"api_key",
	"password",
	"secret",
	"authorization",
	"set-cookie",
] as const;
const REDACTED = "[redacted]";
const IS_WINDOWS = process.platform === "win32";

/** Operational error (SPEC §16.3): the executable identifier is not supported. */
export class UnsupportedExecutableError extends Error {
	readonly id: string;

	constructor(id: string, supported: readonly string[]) {
		super(`unsupported executable identifier "${id}" (must be one of: ${supported.join(", ")})`);
		this.name = "UnsupportedExecutableError";
		this.id = id;
	}
}

/** Operational error (SPEC §16.3): the process request itself is invalid. */
export class InvalidProcessRequestError extends Error {
	constructor(reason: string) {
		super(`invalid controlled process request: ${reason}`);
		this.name = "InvalidProcessRequestError";
	}
}

declare const resolvedExecutableBrand: unique symbol;

/**
 * A trellis-resolved executable reference — an id plus the absolute path
 * trellis resolved for it. Constructed only by {@link resolveExecutable}
 * and {@link pinnedExecutable}; never built from target- or
 * operator-provided values.
 */
export interface ResolvedExecutable {
	readonly id: string;
	readonly path: string;
	readonly [resolvedExecutableBrand]: true;
}

/**
 * Trellis-owned executable registry: the identifiers this step supports, each with its own
 * resolution — the only place an identifier becomes a path. `jscpd` resolves via the verified
 * pinned-tool manifest/resolver (`trellis-ff52`); an absent or host-unsupported pin throws
 * `PinnedToolUnavailableError` for callers to translate into provider evidence (§16.3).
 */
const SUPPORTED_EXECUTABLES: Readonly<Record<string, () => string>> = {
	bun: () => process.execPath,
	jscpd: () => requirePinnedToolExecutable("jscpd"),
};

/** Resolve a supported executable identifier, rejecting anything else. */
export function resolveExecutable(id: string): ResolvedExecutable {
	const resolver = Object.hasOwn(SUPPORTED_EXECUTABLES, id) ? SUPPORTED_EXECUTABLES[id] : undefined;
	if (resolver === undefined) {
		throw new UnsupportedExecutableError(id, Object.keys(SUPPORTED_EXECUTABLES));
	}
	return pinnedExecutable(id, resolver());
}

/**
 * Reference a trellis-discovered pinned artifact (SPEC §16.4 — pinned and discoverable offline,
 * `trellis-ff52`) as the executable to run: an absolute path from trellis-owned discovery —
 * never from the target workspace, operator configuration, or a command string.
 */
export function pinnedExecutable(id: string, path: string): ResolvedExecutable {
	if (typeof id !== "string" || id === "") {
		throw new UnsupportedExecutableError(String(id), Object.keys(SUPPORTED_EXECUTABLES));
	}
	if (typeof path !== "string" || path === "" || !path.startsWith("/") || path.includes("\u0000")) {
		throw new InvalidProcessRequestError(
			`executable for "${id}" must be an absolute, non-empty path (got: ${JSON.stringify(path)})`,
		);
	}
	// The brand key above is type-only; construction succeeds only through these constructors.
	return { id, path } as ResolvedExecutable;
}

/** Request for {@link runControlledProcess}. */
export interface ControlledProcessRequest {
	/**
	 * Fixed argument array — passed to the executable verbatim, never
	 * joined or shell-interpreted.
	 */
	readonly args: readonly string[];
	/** Working directory of the child; defaults to the trellis process cwd. */
	readonly cwd?: string;
	/**
	 * Explicit environment: the child receives exactly this map. Nothing is
	 * inherited from the trellis process. Defaults to an empty environment.
	 */
	readonly env?: Record<string, string>;
	/** Wall-time limit for the whole run in milliseconds (positive integer). */
	readonly timeoutMs: number;
	/** Output limit in bytes, enforced per stream (positive integer). */
	readonly maxOutputBytes: number;
	/** Cancellation handle: aborting terminates the child process group. */
	readonly signal?: AbortSignal;
}

/**
 * One structured execution outcome. The non-exit kinds carry a bounded,
 * scrubbed `reason`; `exited`/`signaled` report what the OS observed.
 * There is deliberately no "success" or "complete" variant — a raw exit
 * code (even 0) never asserts analysis completeness (§16.2).
 */
export type ControlledProcessOutcome =
	| { readonly kind: "missing-executable"; readonly reason: string }
	| { readonly kind: "startup-failed"; readonly reason: string }
	| { readonly kind: "exited"; readonly exitCode: number }
	| { readonly kind: "signaled"; readonly signalCode: string }
	| { readonly kind: "timeout"; readonly reason: string }
	| { readonly kind: "cancelled"; readonly reason: string }
	| {
			readonly kind: "output-overflow";
			readonly reason: string;
			readonly stream: "stdout" | "stderr";
	  };

/** Structured result of one controlled provider process run. */
export interface ControlledProcessResult {
	/** The resolved executable id that ran (provenance for adapters). */
	readonly executableId: string;
	/** What happened; first cause wins when events race. */
	readonly outcome: ControlledProcessOutcome;
	/** Bounded stdout (truncated with a marker on overflow). Never scrubbed. */
	readonly stdout: string;
	/** Bounded, scrubbed stderr (provider diagnostics surface). */
	readonly stderr: string;
}

interface BoundedOutput {
	readonly text: string;
	readonly overflowed: boolean;
}

function isStringArray(value: readonly unknown[] | undefined): value is readonly string[] {
	if (!Array.isArray(value)) return false;
	return value.every((entry) => typeof entry === "string");
}

function isEnvRecord(value: unknown): value is Record<string, string> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (key === "" || key.includes("=") || key.includes("\u0000")) return false;
		if (typeof entry !== "string" || entry.includes("\u0000")) return false;
	}
	return true;
}

function assertRequest(request: ControlledProcessRequest): void {
	if (request === null || typeof request !== "object") {
		throw new InvalidProcessRequestError("request must be an object");
	}
	if (!isStringArray(request.args)) {
		throw new InvalidProcessRequestError("args must be a fixed array of strings");
	}
	if (request.env !== undefined && !isEnvRecord(request.env)) {
		throw new InvalidProcessRequestError("env must map string keys to string values");
	}
	if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
		throw new InvalidProcessRequestError("timeoutMs must be a positive integer");
	}
	if (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes <= 0) {
		throw new InvalidProcessRequestError("maxOutputBytes must be a positive integer");
	}
}

/** Does this environment key name carry a sensitive value (AGENTS.md §Log scrubbing)? */
function isSensitiveEnvKey(key: string): boolean {
	const lowered = key.toLowerCase();
	return SENSITIVE_ENV_KEY_NAMES.some((name) => lowered.includes(name));
}

/**
 * Replace every occurrence of a sensitive environment value in `text` with
 * a redaction marker, so bounded diagnostics never echo credentials the
 * caller chose to pass. Exported for reuse by future diagnostic surfaces.
 */
export function scrubSensitiveValues(text: string, env: Record<string, string>): string {
	let scrubbed = text;
	for (const [key, value] of Object.entries(env)) {
		if (value === "" || !isSensitiveEnvKey(key)) continue;
		scrubbed = scrubbed.split(value).join(REDACTED);
	}
	return scrubbed;
}

function errorMessage(error: unknown, env: Record<string, string>): string {
	const raw = error instanceof Error ? error.message : String(error);
	return scrubSensitiveValues(raw, env);
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
	const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return merged;
}

/** Read one output stream up to `maxBytes`, invoking `onOverflow` on excess. */
async function readBounded(
	stream: ReadableStream<Uint8Array>,
	maxBytes: number,
	onOverflow: () => void,
): Promise<BoundedOutput> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done || value === undefined) {
			return { text: decoder.decode(concatBytes(chunks)), overflowed: false };
		}
		if (total + value.byteLength > maxBytes) {
			const keep = maxBytes - total;
			if (keep > 0) chunks.push(value.subarray(0, keep));
			onOverflow();
			try {
				await reader.cancel();
			} catch {
				// Stream already closed — nothing left to discard.
			}
			return { text: decoder.decode(concatBytes(chunks)), overflowed: true };
		}
		chunks.push(value);
		total += value.byteLength;
	}
	return { text: decoder.decode(concatBytes(chunks)), overflowed: false };
}

/**
 * Run one controlled provider process (see the module docblock for the
 * enforced boundary). Resolves with a structured result for every defined
 * outcome — the promise only rejects on an invalid request or an
 * unresolvable executable, which is operational error territory
 * (SPEC §16.3), never provider evidence.
 */
export async function runControlledProcess(
	executable: ResolvedExecutable,
	request: ControlledProcessRequest,
): Promise<ControlledProcessResult> {
	assertRequest(request);
	const env = request.env ?? {};
	if (request.signal?.aborted) {
		return finished(
			executable,
			{ kind: "cancelled", reason: "cancelled before start; nothing was executed" },
			"",
			"",
			env,
		);
	}

	let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
	try {
		proc = Bun.spawn([executable.path, ...request.args], {
			cwd: request.cwd,
			env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			// POSIX: a new process group, so a limit can terminate the whole
			// tree — supported invocation shapes leave no orphan descendants.
			detached: !IS_WINDOWS,
		});
	} catch (error) {
		const reason = errorMessage(error, env);
		const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
		const outcome =
			code === "ENOENT"
				? ({ kind: "missing-executable", reason } as const)
				: ({ kind: "startup-failed", reason } as const);
		return finished(executable, outcome, "", "", env);
	}

	let outcome: ControlledProcessOutcome | undefined;
	const take = (candidate: ControlledProcessOutcome): void => {
		if (outcome === undefined) outcome = candidate;
	};
	const terminateGroup = (): void => {
		try {
			if (IS_WINDOWS) proc.kill();
			else process.kill(-proc.pid, "SIGKILL");
		} catch {
			// The process group is already gone — nothing left to terminate.
		}
	};

	const readStdout = readBounded(proc.stdout, request.maxOutputBytes, () => {
		take({
			kind: "output-overflow",
			reason: `stdout exceeded the ${request.maxOutputBytes}-byte limit; output truncated and process group terminated`,
			stream: "stdout",
		});
		terminateGroup();
	});
	const readStderr = readBounded(proc.stderr, request.maxOutputBytes, () => {
		take({
			kind: "output-overflow",
			reason: `stderr exceeded the ${request.maxOutputBytes}-byte limit; output truncated and process group terminated`,
			stream: "stderr",
		});
		terminateGroup();
	});
	const exitedWatch = proc.exited.then(() => {
		if (proc.exitCode !== null) take({ kind: "exited", exitCode: proc.exitCode });
		else take({ kind: "signaled", signalCode: proc.signalCode ?? "unknown" });
	});
	const timer = setTimeout(() => {
		take({
			kind: "timeout",
			reason: `wall-time limit of ${request.timeoutMs}ms exceeded; process group terminated`,
		});
		terminateGroup();
	}, request.timeoutMs);
	const onAbort = (): void => {
		take({ kind: "cancelled", reason: "cancelled by caller; process group terminated" });
		terminateGroup();
	};
	request.signal?.addEventListener("abort", onAbort);

	const [stdout, stderr] = await Promise.all([readStdout, readStderr, exitedWatch]);
	clearTimeout(timer);
	request.signal?.removeEventListener("abort", onAbort);

	const finalOutcome: ControlledProcessOutcome = outcome ?? {
		kind: "signaled",
		signalCode: proc.signalCode ?? "unknown",
	};
	const stdoutText = stdout.overflowed
		? `${stdout.text}...[truncated at ${request.maxOutputBytes} bytes]`
		: stdout.text;
	const stderrText = stderr.overflowed
		? `${stderr.text}...[truncated at ${request.maxOutputBytes} bytes]`
		: stderr.text;
	return finished(executable, finalOutcome, stdoutText, stderrText, env);
}

/** Build the final result; `env` drives stderr scrubbing. */
function finished(
	executable: ResolvedExecutable,
	outcome: ControlledProcessOutcome,
	stdout: string,
	stderr: string,
	env: Record<string, string>,
): ControlledProcessResult {
	return {
		executableId: executable.id,
		outcome,
		stdout,
		// Bounded provider diagnostics never echo sensitive environment values.
		stderr: scrubSensitiveValues(stderr, env),
	};
}
