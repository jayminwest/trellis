/**
 * Scripted fake Pi process for offline tests (SPEC §9.7) — a {@link PiSpawn}
 * that emits pre-canned JSONL "turns" in reaction to stdin prompts, with **zero
 * network or model access**. Each `writeStdin` (the initial prompt, then each
 * corrective re-prompt) releases the next scripted turn onto stdout, so the
 * session loop's retry/corrective/watchdog/exit paths are all exercisable
 * deterministically.
 *
 * This module is test-only; it ships under `src/` so the typechecker and
 * coverage ratchet see it like any other unit.
 */

import type { PiProcessHandle, PiSpawn } from "./session.ts";

/** A single Pi "turn": the stdout envelopes emitted in response to one prompt. */
export type FakeTurn = readonly Record<string, unknown>[];

/** Knobs for {@link makeFakePi}. */
export interface FakePiOptions {
	/** Exit code reported when stdin is closed (default 0). */
	readonly exitOnCloseCode?: number;
	/**
	 * If set, the process self-exits with this code on the Nth `writeStdin`
	 * (1-based) *instead of* emitting a turn — models Pi dying mid-session.
	 */
	readonly exitOnWrite?: { readonly nth: number; readonly code: number };
}

/** A fake Pi handle plus introspection into what the session wrote to it. */
export interface FakePi {
	readonly spawn: PiSpawn;
	/** Every raw line the session wrote to stdin, in order. */
	readonly writes: string[];
	/** The argv/env/cwd the session spawned with (set on first spawn). */
	spawnCtx?: { argv: string[]; env: Record<string, string>; cwd: string };
}

/**
 * Build a scripted fake Pi. `turns[0]` is released on the initial prompt,
 * `turns[1]` on the first corrective re-prompt, and so on; a prompt with no
 * corresponding turn releases nothing (modelling a stall, for watchdog tests).
 */
export function makeFakePi(turns: readonly FakeTurn[], opts: FakePiOptions = {}): FakePi {
	const writes: string[] = [];
	const encoder = new TextEncoder();

	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	const stdout = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});

	let closed = false;
	let resolveExit: (code: number) => void = () => {};
	const exited = new Promise<number>((r) => {
		resolveExit = r;
	});

	let turnIndex = 0;
	let writeCount = 0;

	const finish = (code: number): void => {
		if (closed) return;
		closed = true;
		try {
			controller?.close();
		} catch {
			// already closed
		}
		resolveExit(code);
	};

	const releaseTurn = (): void => {
		const turn = turns[turnIndex++];
		if (!turn || closed) return;
		for (const envelope of turn)
			controller?.enqueue(encoder.encode(`${JSON.stringify(envelope)}\n`));
	};

	const handle: PiProcessHandle = {
		stdout,
		writeStdin(line: string): void {
			writes.push(line);
			writeCount++;
			if (opts.exitOnWrite && writeCount === opts.exitOnWrite.nth) {
				const code = opts.exitOnWrite.code;
				queueMicrotask(() => finish(code));
				return;
			}
			queueMicrotask(releaseTurn);
		},
		closeStdin(): void {
			finish(opts.exitOnCloseCode ?? 0);
		},
		kill(): void {
			finish(143);
		},
		exited,
	};

	const fake: FakePi = {
		writes,
		spawn(ctx) {
			fake.spawnCtx = { argv: [...ctx.argv], env: { ...ctx.env }, cwd: ctx.cwd };
			return handle;
		},
	};
	return fake;
}

// --- envelope builders (the shapes pi --mode rpc v0.74.0 emits) --------------

/** An assistant `message_end` carrying a `submit_findings` toolCall. */
export function submitFindingsTurn(args: unknown): FakeTurn {
	return [
		{
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "call-1", name: "submit_findings", arguments: args }],
			},
		},
	];
}

/** An assistant turn that calls submit_findings then ends without a valid retry. */
export function invalidThenEndTurn(args: unknown): FakeTurn {
	return [...submitFindingsTurn(args), { type: "agent_end" }];
}

/** A turn that produces no tool call and just ends (the "no submission" case). */
export const noSubmissionTurn: FakeTurn = [
	{
		type: "message_end",
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
	},
	{ type: "agent_end" },
];

/** A turn whose assistant message reports a provider error. */
export const errorTurn: FakeTurn = [
	{ type: "message_end", message: { role: "assistant", stopReason: "error", content: [] } },
];
