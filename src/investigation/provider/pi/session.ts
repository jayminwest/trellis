/**
 * Pi RPC session loop (SPEC §9.3) — the request/response protocol that turns a
 * spawned `pi --mode rpc` process into one validated findings object (or an
 * honest `no-detector`).
 *
 * The protocol, exactly as burrow proved it:
 *  1. Write one `{"type":"prompt",...}` line and **hold stdin open** — Pi exits
 *     the instant stdin closes, even mid-inference (burrow's mx-d9b3ad).
 *  2. Read stdout JSONL, watching assistant `message_end` content blocks for a
 *     `toolCall` named `submit_findings`; its `arguments` is the candidate facts.
 *  3. zod-validate the arguments. Valid → close stdin (Pi exits) and resolve.
 *  4. On a finished run (`agent_end`) with no valid capture, send ONE corrective
 *     prompt echoing the zod errors, bounded to N retries (default 2).
 *  5. Exhausted retries / `stopReason:error` / a heartbeat stall / process exit
 *     → resolve `no-detector` with the failure rationale — **never a fabricated
 *     pass**.
 *
 * The process boundary is injectable ({@link PiSpawn}) so the whole loop —
 * argv-agnostic — is exercised against a scripted fake Pi with zero network or
 * model access (SPEC §9.7).
 */

import type { z } from "zod";
import { MAX_RATIONALE } from "../../../scoring/index.ts";
import { SUBMIT_FINDINGS_TOOL } from "./argv.ts";

/** A spawned Pi process, reduced to the surface the session loop drives. */
export interface PiProcessHandle {
	/** Pi's stdout as a byte stream of newline-delimited JSON events. */
	readonly stdout: ReadableStream<Uint8Array>;
	/** Write a raw line (caller includes the trailing newline) to Pi's stdin. */
	writeStdin(line: string): void;
	/** Close stdin — Pi exits through its RPC read loop. */
	closeStdin(): void;
	/** Force-terminate the process (watchdog path). */
	kill(): void;
	/** Resolves with the process exit code when Pi exits. */
	readonly exited: Promise<number>;
}

/** How the session spawns Pi (real: {@link defaultPiSpawn}; tests: a fake). */
export type PiSpawn = (ctx: {
	readonly argv: string[];
	readonly env: Record<string, string>;
	readonly cwd: string;
}) => PiProcessHandle;

/** The result of one Pi session: validated facts, or an honest failure reason. */
export type SessionOutcome =
	| { readonly ok: true; readonly findings: unknown }
	| { readonly ok: false; readonly reason: string };

/**
 * Session-level progress events the §9.3 loop surfaces for observability only.
 * They never alter control flow — the protocol state machine is unchanged
 * whether or not a sink is wired (api>cli>sdk: core emits, the CLI renders).
 */
export type SessionEvent =
	| { readonly type: "message" }
	| { readonly type: "agent-end" }
	| { readonly type: "retry"; readonly attempt: number }
	| { readonly type: "heartbeat-stall" };

/** Inputs to {@link runPiSession}. */
export interface PiSessionConfig {
	readonly argv: string[];
	readonly env: Record<string, string>;
	readonly cwd: string;
	/** The kickoff user prompt (the system prompt is already on argv). */
	readonly promptMessage: string;
	/** zod schema the captured `submit_findings` arguments are validated against. */
	readonly schema: z.ZodType;
	/** Corrective re-prompt budget after the first attempt (SPEC default 2). */
	readonly maxRetries: number;
	/** Watchdog: force-terminate if no stdout line arrives within this many ms. */
	readonly heartbeatMs: number;
	/** Process-boundary injection (default {@link defaultPiSpawn}). */
	readonly spawn?: PiSpawn;
	/** Optional observability sink for {@link SessionEvent}s; never affects control flow. */
	readonly onEvent?: (event: SessionEvent) => void;
}

/** Default corrective re-prompt budget (SPEC §9.3). */
export const DEFAULT_MAX_RETRIES = 2;

/** Default heartbeat watchdog window (ms): a run with no output for this long stalls. */
export const DEFAULT_HEARTBEAT_MS = 120_000;

/** Encode a Pi `prompt` RPC command as a single newline-terminated line. */
export function promptCommand(message: string): string {
	return `${JSON.stringify({ type: "prompt", message })}\n`;
}

/** Compact a zod error into a bounded, single-line corrective hint. */
export function formatZodIssues(error: z.ZodError): string {
	const parts = error.issues.map((issue) => {
		const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
		return `${path}: ${issue.message}`;
	});
	const joined = parts.join("; ");
	return joined.length > MAX_RATIONALE ? `${joined.slice(0, MAX_RATIONALE - 1)}…` : joined;
}

/** Default spawn: a real `pi --mode rpc` child via Bun, stdin held open. */
export const defaultPiSpawn: PiSpawn = ({ argv, env, cwd }) => {
	const proc = Bun.spawn(argv, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
	const sink = proc.stdin;
	return {
		stdout: proc.stdout as ReadableStream<Uint8Array>,
		writeStdin(line: string): void {
			sink.write(line);
			sink.flush();
		},
		closeStdin(): void {
			try {
				sink.end();
			} catch {
				// already closed
			}
		},
		kill(): void {
			try {
				proc.kill();
			} catch {
				// already gone
			}
		},
		exited: proc.exited,
	};
};

/** A minimal Pi stdout envelope shape (only the fields the loop reads). */
interface PiEnvelope {
	type?: string;
	message?: {
		role?: string;
		stopReason?: string;
		content?: Array<{ type?: string; name?: string; arguments?: unknown }>;
	};
}

function parseEnvelope(line: string): PiEnvelope | null {
	const trimmed = line.trim();
	if (trimmed.length === 0) return null;
	try {
		const parsed = JSON.parse(trimmed);
		return parsed && typeof parsed === "object" ? (parsed as PiEnvelope) : null;
	} catch {
		return null; // non-JSON noise (banners, blank lines) is ignored
	}
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Mutable per-run state for the protocol state machine. The handler functions
 * below are deliberately module-level (not nested closures) so each stays a
 * small, independently-readable unit of the §9.3 flow; `run` threads this state
 * through them.
 */
interface Session {
	readonly cfg: PiSessionConfig;
	readonly proc: PiProcessHandle;
	readonly resolve: (outcome: SessionOutcome) => void;
	settled: boolean;
	retries: number;
	lastInvalidReason?: string;
	sawInvalidThisRun: boolean;
	heartbeat?: ReturnType<typeof setTimeout>;
}

/** Forward a {@link SessionEvent} to the optional sink (observability only). */
function emitEvent(st: Session, event: SessionEvent): void {
	st.cfg.onEvent?.(event);
}

/** Resolve the session exactly once, tearing down the process and watchdog. */
function settle(st: Session, outcome: SessionOutcome): void {
	if (st.settled) return;
	st.settled = true;
	if (st.heartbeat) clearTimeout(st.heartbeat);
	st.proc.closeStdin();
	st.proc.kill();
	st.resolve(outcome);
}

/** (Re)arm the heartbeat watchdog: a silent run past the window is force-killed. */
function bumpHeartbeat(st: Session): void {
	if (st.heartbeat) clearTimeout(st.heartbeat);
	st.heartbeat = setTimeout(() => {
		emitEvent(st, { type: "heartbeat-stall" });
		settle(st, { ok: false, reason: `heartbeat: no Pi output for ${st.cfg.heartbeatMs}ms` });
	}, st.cfg.heartbeatMs);
}

/** Write a prompt line, holding stdin open; a write failure settles no-detector. */
function sendPrompt(st: Session, message: string, what: string): void {
	try {
		st.proc.writeStdin(promptCommand(message));
	} catch (err) {
		settle(st, { ok: false, reason: `failed to send ${what}: ${errMessage(err)}` });
	}
}

const retriesWord = (n: number): string => (n === 1 ? "retry" : "retries");

/** Scan an assistant message for a `submit_findings` call and validate it (SPEC §9.3). */
function handleMessageEnd(st: Session, envelope: PiEnvelope): void {
	const msg = envelope.message;
	if (msg?.role !== "assistant" || !Array.isArray(msg.content)) return;
	emitEvent(st, { type: "message" });
	if (msg.stopReason === "error") {
		settle(st, { ok: false, reason: "Pi assistant turn reported stopReason:error" });
		return;
	}
	for (const block of msg.content) {
		if (block?.type !== "toolCall" || block.name !== SUBMIT_FINDINGS_TOOL) continue;
		const parsed = st.cfg.schema.safeParse(block.arguments);
		if (parsed.success) {
			settle(st, { ok: true, findings: parsed.data });
			return;
		}
		st.sawInvalidThisRun = true;
		st.lastInvalidReason = formatZodIssues(parsed.error);
	}
}

/** A run finished with no valid capture: send a corrective prompt or give up. */
function handleAgentEnd(st: Session): void {
	emitEvent(st, { type: "agent-end" });
	if (st.retries <= 0) {
		const word = retriesWord(st.cfg.maxRetries);
		const reason = st.lastInvalidReason
			? `findings invalid after ${st.cfg.maxRetries} ${word}: ${st.lastInvalidReason}`
			: `no submit_findings call after ${st.cfg.maxRetries} ${word}`;
		settle(st, { ok: false, reason });
		return;
	}
	st.retries--;
	emitEvent(st, { type: "retry", attempt: st.cfg.maxRetries - st.retries });
	const corrective =
		st.sawInvalidThisRun && st.lastInvalidReason
			? `Your submit_findings call did not match the schema: ${st.lastInvalidReason}. Call submit_findings again with corrected facts.`
			: "You did not call submit_findings. Investigate the area and call submit_findings exactly once with the gathered facts.";
	st.sawInvalidThisRun = false;
	sendPrompt(st, corrective, "corrective prompt");
}

/** Route one stdout line to its handler (non-JSON / irrelevant lines are ignored). */
function handleLine(st: Session, line: string): void {
	const envelope = parseEnvelope(line);
	if (!envelope) return;
	if (envelope.type === "message_end") handleMessageEnd(st, envelope);
	else if (envelope.type === "agent_end") handleAgentEnd(st);
}

/** Consume Pi's stdout JSONL, bumping the watchdog on every chunk (SPEC §9.3 step 2). */
async function pumpStdout(st: Session): Promise<void> {
	const reader = st.proc.stdout.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		bumpHeartbeat(st);
		buffer += decoder.decode(value, { stream: true });
		let nl = buffer.indexOf("\n");
		while (nl !== -1) {
			handleLine(st, buffer.slice(0, nl));
			if (st.settled) return;
			buffer = buffer.slice(nl + 1);
			nl = buffer.indexOf("\n");
		}
	}
}

/**
 * Drive one Pi RPC session to a {@link SessionOutcome}. Pure with respect to
 * everything but the injected process: no argv/env decisions here (the caller
 * assembled them) — this is solely the protocol state machine.
 */
export function runPiSession(cfg: PiSessionConfig): Promise<SessionOutcome> {
	const spawn = cfg.spawn ?? defaultPiSpawn;
	const proc = spawn({ argv: cfg.argv, env: cfg.env, cwd: cfg.cwd });

	return new Promise<SessionOutcome>((resolve) => {
		const st: Session = {
			cfg,
			proc,
			resolve,
			settled: false,
			retries: cfg.maxRetries,
			sawInvalidThisRun: false,
		};
		// Pi exiting before we capture findings is a failure, never a pass.
		void proc.exited.then((code) =>
			settle(st, { ok: false, reason: `Pi exited (code ${code}) without submitting findings` }),
		);
		// Step 1: kick off the run, holding stdin open.
		sendPrompt(st, cfg.promptMessage, "initial prompt");
		if (st.settled) return;
		bumpHeartbeat(st);
		// Step 2: consume stdout line-by-line.
		void pumpStdout(st).catch((err) =>
			settle(st, { ok: false, reason: `Pi stdout read error: ${errMessage(err)}` }),
		);
	});
}
