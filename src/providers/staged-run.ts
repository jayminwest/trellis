/**
 * The staged-view lifecycle wrapper (SPEC §16.4, plan `pl-43c5` —
 * trellis-2fe6): run one provider adapter callback against a staged
 * workspace view with guaranteed trellis-owned scratch cleanup.
 *
 * `withStagedWorkspaceView` composes {@link stageWorkspaceView} with the
 * adapter callback and cleans the owned scratch directory on **every** exit
 * path: adapter success, adapter failure, wall-time timeout, and caller
 * cancellation (an already-aborted signal stages nothing at all). Outcomes
 * are structured — an adapter failure is carried, not rethrown, so callers
 * translate it into located provider evidence states (§16.3) — and a cleanup
 * failure is reported in the outcome without ever masking the original
 * result: the adapter's value or error always wins its outcome kind.
 *
 * The wall-time limit bounds **waiting** for the adapter, not the adapter
 * itself: adapters drive `runControlledProcess` (process.ts) with the same
 * signal, which terminates the provider's process group, so a limit actually
 * stops the work. After a timeout or cancellation the wrapper stops waiting
 * and cleans immediately; a callback that ignores the signal keeps running
 * detached over its already-removed scratch and its late result is
 * discarded. No execution metadata (timestamps, pids, durations) is
 * recorded, preserving determinism of downstream evidence.
 */

import { type CleanupStatus, InvalidStagingRequestError, type StagingRequest } from "./staging.ts";
import type { StagedWorkspaceView } from "./workspace.ts";
import { stageWorkspaceView } from "./workspace.ts";

/** Options for {@link withStagedWorkspaceView}. */
export interface StagedRunOptions {
	/** Wall-time limit for waiting on the adapter callback, in milliseconds. */
	timeoutMs?: number;
	/** Cancellation handle; aborting stops waiting and triggers cleanup. */
	signal?: AbortSignal;
}

/** One structured lifecycle outcome; `cleanup` reports scratch removal. */
export type StagedRunOutcome<T> =
	| { kind: "completed"; value: T; cleanup: CleanupStatus }
	| { kind: "adapter-failed"; error: unknown; cleanup: CleanupStatus }
	| { kind: "timeout"; cleanup: CleanupStatus }
	| { kind: "cancelled"; cleanup: CleanupStatus };

/** Settled adapter result — errors are carried, never rethrown here. */
type RunResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

type RaceWinner<T> =
	| { kind: "run"; result: RunResult<T> }
	| { kind: "timeout" }
	| { kind: "cancelled" };

/** A promise that never settles (absent limit/signal slots in the race). */
const NEVER_SETTLES: Promise<never> = new Promise(() => {});

function assertOptions(run: unknown, options: StagedRunOptions): void {
	if (typeof run !== "function") {
		throw new InvalidStagingRequestError("run must be a function accepting the staged view");
	}
	if (options === null || typeof options !== "object") {
		throw new InvalidStagingRequestError("options must be an object");
	}
	const { timeoutMs, signal } = options;
	if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
		throw new InvalidStagingRequestError("timeoutMs must be a positive integer");
	}
	if (
		signal !== undefined &&
		(typeof signal !== "object" || signal === null || typeof signal.addEventListener !== "function")
	) {
		throw new InvalidStagingRequestError("signal must be an AbortSignal");
	}
}

/**
 * Run `run` against a freshly staged view of `request`, cleaning the owned
 * scratch on every exit path (see the module docblock). Rejects only on
 * invalid requests and staging failures — operational errors, SPEC §16.3 —
 * never on adapter outcomes.
 */
export async function withStagedWorkspaceView<T>(
	request: StagingRequest,
	run: (view: StagedWorkspaceView) => Promise<T>,
	options: StagedRunOptions = {},
): Promise<StagedRunOutcome<T>> {
	assertOptions(run, options);
	const { timeoutMs, signal } = options;
	if (signal?.aborted) {
		return { kind: "cancelled", cleanup: { status: "nothing-to-clean" } };
	}

	const view = await stageWorkspaceView(request);
	const runSettled = (async (): Promise<RunResult<T>> => {
		try {
			return { ok: true, value: await run(view) };
		} catch (error) {
			return { ok: false, error };
		}
	})();

	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	const winner: RaceWinner<T> = await Promise.race([
		runSettled.then((result) => ({ kind: "run" as const, result })),
		timeoutMs === undefined
			? NEVER_SETTLES
			: new Promise<{ kind: "timeout" }>((resolve) => {
					timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
				}),
		signal === undefined
			? NEVER_SETTLES
			: new Promise<{ kind: "cancelled" }>((resolve) => {
					if (signal.aborted) resolve({ kind: "cancelled" });
					else {
						onAbort = () => resolve({ kind: "cancelled" });
						signal.addEventListener("abort", onAbort);
					}
				}),
	]);
	if (timer !== undefined) clearTimeout(timer);
	if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);

	const cleanup = await view.cleanup();
	if (winner.kind === "run") {
		return winner.result.ok
			? { kind: "completed", value: winner.result.value, cleanup }
			: { kind: "adapter-failed", error: winner.result.error, cleanup };
	}
	return winner.kind === "timeout" ? { kind: "timeout", cleanup } : { kind: "cancelled", cleanup };
}
