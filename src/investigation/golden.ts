/**
 * Golden-fixture support for the investigation layer (SPEC §9.7).
 *
 * Mirrors burrow's golden methodology: for each area, one `pi --mode rpc`
 * session — the full JSONL event stream including the `submit_findings`
 * `toolCall` — is captured into `__golden__/<area>.jsonl`, **canonicalized**
 * (volatile fields → fixed placeholders), and frozen. Tests then replay each
 * frozen stream through the real session loop → zod validation → deterministic
 * grader, **entirely offline** (no `pi`, no network, no model).
 *
 * This module owns the two halves of that contract:
 *  - {@link canonicalizePiStream} — the normalization applied at capture time
 *    so a re-record produces a byte-stable diff (it is idempotent, so the test
 *    suite can assert a frozen golden is already canonical).
 *  - {@link loadGolden} / {@link goldenEnvelopes} — read a frozen stream back
 *    into the envelope array the replay spawn emits.
 *
 * The capture itself (one live Pi run per area) is the operator's job, gated
 * behind `scripts/update-pi-golden.ts`. Until a live capture exists the frozen
 * fixtures are **hand-authored** to the documented v0.74.0 wire shape — see
 * `__golden__/README.md`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AREA_IDS, type AreaId } from "./areas.ts";

/** Absolute path to the frozen golden streams. */
export const GOLDEN_DIR = join(import.meta.dir, "__golden__");

/** The golden stream filename for an area (one captured session per area). */
export function goldenFileName(area: AreaId): string {
	return `${area}.jsonl`;
}

/**
 * The corrupted-golden fixture: a captured stream whose `submit_findings`
 * arguments fail zod validation (a smuggled verdict-shaped key). Replayed, it
 * exercises the corrective-prompt → `no-detector` degradation path.
 */
export const CORRUPTED_GOLDEN_FILE = "corrupted.jsonl";

// --- canonicalization --------------------------------------------------------

/** Fixed placeholders volatile fields collapse to (so re-records diff cleanly). */
export const CANONICAL = {
	/** Session/message/tool-call/response ids. */
	id: "00000000-0000-0000-0000-000000000000",
	/** Any wall-clock timestamp. */
	timestamp: "1970-01-01T00:00:00.000Z",
	/** Token-usage accounting. */
	usage: { inputTokens: 0, outputTokens: 0 } as const,
} as const;

/** Object keys whose value is an id → {@link CANONICAL.id}. */
const ID_KEYS = new Set([
	"id",
	"sessionId",
	"responseId",
	"messageId",
	"parentId",
	"requestId",
	"callId",
	"toolCallId",
]);

/** Object keys whose value is a timestamp → {@link CANONICAL.timestamp}. */
const TIMESTAMP_KEYS = new Set([
	"timestamp",
	"createdAt",
	"startedAt",
	"endedAt",
	"completedAt",
	"time",
]);

/** Object keys whose numeric value is non-deterministic accounting → `0`. */
const ZERO_KEYS = new Set(["cost", "costUsd", "durationMs", "latencyMs", "elapsedMs"]);

/** Canonicalize one object field by its key, recursing into non-volatile values. */
function canonicalizeField(key: string, val: unknown): unknown {
	if (key === "usage") return { ...CANONICAL.usage };
	if (typeof val === "string" && ID_KEYS.has(key)) return CANONICAL.id;
	if (typeof val === "string" && TIMESTAMP_KEYS.has(key)) return CANONICAL.timestamp;
	if (typeof val === "number" && ZERO_KEYS.has(key)) return 0;
	return canonicalizeValue(val);
}

/** Recursively replace volatile fields with fixed placeholders (idempotent). */
function canonicalizeValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalizeValue);
	if (value === null || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
		out[key] = canonicalizeField(key, val);
	}
	return out;
}

/**
 * Canonicalize a raw Pi RPC stdout stream into a byte-stable golden. Each
 * non-empty line is parsed as JSON, its volatile fields normalized, and
 * re-serialized one envelope per line with a trailing newline. Idempotent:
 * canonicalizing an already-canonical stream returns it unchanged. Throws on a
 * line that is not valid JSON (a malformed capture must fail loudly, never
 * freeze silently).
 */
export function canonicalizePiStream(raw: string): string {
	const lines = raw.split("\n").filter((line) => line.trim().length > 0);
	return lines
		.map((line, index) => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				throw new Error(`golden stream line ${index + 1} is not valid JSON: ${detail}`);
			}
			return JSON.stringify(canonicalizeValue(parsed));
		})
		.map((line) => `${line}\n`)
		.join("");
}

// --- loading -----------------------------------------------------------------

/** A parsed Pi stdout envelope (the recorded stream is an ordered array of these). */
export type GoldenEnvelope = Record<string, unknown>;

/** Parse a canonical JSONL stream into its ordered envelope array. */
export function parseGoldenStream(text: string): GoldenEnvelope[] {
	return text
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as GoldenEnvelope);
}

/** Read a frozen golden file's raw text from {@link GOLDEN_DIR}. */
export function loadGolden(fileName: string): string {
	return readFileSync(join(GOLDEN_DIR, fileName), "utf8");
}

/** Read and parse an area's frozen golden stream into envelopes. */
export function goldenEnvelopes(area: AreaId): GoldenEnvelope[] {
	return parseGoldenStream(loadGolden(goldenFileName(area)));
}

/** Every area's golden filename, in {@link AREA_IDS} order (capture work-list). */
export const AREA_GOLDEN_FILES: readonly { area: AreaId; file: string }[] = AREA_IDS.map(
	(area) => ({
		area,
		file: goldenFileName(area),
	}),
);
