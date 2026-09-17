/**
 * Clone-matching engine (SPEC §5.3, trellis-6e4c) — sliding-window hashing
 * and maximal-match extension over the concatenated token streams of one
 * source set. See `duplication.ts` for the detection contract and the full
 * documented semantics; `duplication-groups.ts` owns finalization.
 *
 * Outline: one set's {@link TokenStream}s are concatenated (windows and
 * extensions never cross file boundaries); every K-token window is hashed
 * (rolling polynomial hash, collisions always verified token-by-token);
 * every pair of equal-hash windows is extended into a maximal match; and
 * matches are merged into raw groups by content identity (same length and
 * verified-equal token sequence — never transitive pairwise merging).
 *
 * The match-work budget counts token comparisons in verification,
 * extension, and merging; the first trip latches `exhausted` and detection
 * stops with the groups found so far — never a silent clean result.
 */
import type ts from "typescript";
import {
	type BudgetExhaustion,
	type CloneDetection,
	DEFAULT_DUPLICATION_BUDGET,
	DUPLICATION_MIN_TOKENS,
	type DuplicationBudget,
	type TokenStream,
} from "./duplication.ts";
import { finalizeGroups, type RawGroup, type RawMember } from "./duplication-groups.ts";

/** Mutable match-work counter; `exhausted` latches on the first budget trip. */
interface WorkState {
	count: number;
	exhausted: boolean;
}

/** Count `n` units of match work; returns false (and latches) once the budget trips. */
function step(work: WorkState, budget: DuplicationBudget, n = 1): boolean {
	work.count += n;
	if (work.count > budget.maxMatchWork) {
		work.exhausted = true;
		return false;
	}
	return true;
}

/** The concatenated detection input: one token array plus per-file boundaries. */
interface Concatenated {
	kinds: ts.SyntaxKind[];
	fileOf: number[];
	fileStart: number[];
	fileEnd: number[];
}

/** Concatenate per-file streams; windows and extensions never cross file boundaries. */
function concatenate(streams: readonly TokenStream[]): Concatenated {
	const kinds: ts.SyntaxKind[] = [];
	const fileOf: number[] = [];
	const fileStart: number[] = [];
	const fileEnd: number[] = [];
	for (const [file, stream] of streams.entries()) {
		fileStart.push(kinds.length);
		for (const kind of stream.kinds) {
			kinds.push(kind);
			fileOf.push(file);
		}
		fileEnd.push(kinds.length);
	}
	return { kinds, fileOf, fileStart, fileEnd };
}

/** Verify the K-token window at `p` and `q` (false on mismatch or exhaustion). */
function verifyWindow(
	kinds: readonly ts.SyntaxKind[],
	p: number,
	q: number,
	work: WorkState,
	budget: DuplicationBudget,
): boolean {
	for (let offset = 0; offset < DUPLICATION_MIN_TOKENS; offset += 1) {
		if (!step(work, budget)) return false;
		if (kinds[p + offset] !== kinds[q + offset]) return false;
	}
	return true;
}

/** Count how far the match extends toward lower token indices (`null` on exhaustion). */
function extendLeft(
	data: Concatenated,
	p: number,
	q: number,
	work: WorkState,
	budget: DuplicationBudget,
): number | null {
	const { kinds, fileOf, fileStart } = data;
	const fileP = fileOf[p] ?? 0;
	const fileQ = fileOf[q] ?? 0;
	let left = 0;
	while (p - left - 1 >= (fileStart[fileP] ?? 0) && q - left - 1 >= (fileStart[fileQ] ?? 0)) {
		if (!step(work, budget)) return null;
		if (kinds[p - left - 1] !== kinds[q - left - 1]) break;
		left += 1;
	}
	return left;
}

/** Count how far the match extends toward higher token indices (`null` on exhaustion). */
function extendRight(
	data: Concatenated,
	p: number,
	q: number,
	work: WorkState,
	budget: DuplicationBudget,
): number | null {
	const { kinds, fileOf, fileEnd } = data;
	const fileP = fileOf[p] ?? 0;
	const fileQ = fileOf[q] ?? 0;
	const baseP = p + DUPLICATION_MIN_TOKENS;
	const baseQ = q + DUPLICATION_MIN_TOKENS;
	let right = 0;
	while (baseP + right < (fileEnd[fileP] ?? 0) && baseQ + right < (fileEnd[fileQ] ?? 0)) {
		if (!step(work, budget)) return null;
		if (kinds[baseP + right] !== kinds[baseQ + right]) break;
		right += 1;
	}
	return right;
}

/**
 * Verify the K-token window at `p` and `q`, then extend both ends while the
 * tokens stay equal (never crossing a file boundary). Returns the maximal
 * match, or `null` on window mismatch or budget exhaustion.
 */
function extendMatch(
	data: Concatenated,
	p: number,
	q: number,
	work: WorkState,
	budget: DuplicationBudget,
): { a: RawMember; b: RawMember; length: number } | null {
	if (!verifyWindow(data.kinds, p, q, work, budget)) return null;
	const left = extendLeft(data, p, q, work, budget);
	if (left === null) return null;
	const right = extendRight(data, p, q, work, budget);
	if (right === null) return null;
	const length = DUPLICATION_MIN_TOKENS + left + right;
	const fileP = data.fileOf[p] ?? 0;
	const fileQ = data.fileOf[q] ?? 0;
	return {
		a: { file: fileP, start: p - left, end: p - left + length },
		b: { file: fileQ, start: q - left, end: q - left + length },
		length,
	};
}

/** Merge one match into the raw groups by content identity (never transitive merging). */
function addMatch(
	byLength: Map<number, RawGroup[]>,
	kinds: readonly ts.SyntaxKind[],
	match: { a: RawMember; b: RawMember; length: number },
	work: WorkState,
	budget: DuplicationBudget,
): void {
	const candidates = byLength.get(match.length) ?? [];
	for (const group of candidates) {
		let equal = true;
		for (let offset = 0; offset < match.length; offset += 1) {
			if (!step(work, budget)) return;
			if (kinds[group.rep.start + offset] !== kinds[match.a.start + offset]) {
				equal = false;
				break;
			}
		}
		if (equal) {
			group.members.set(`${match.a.file}:${match.a.start}`, match.a);
			group.members.set(`${match.b.file}:${match.b.start}`, match.b);
			return;
		}
	}
	const group: RawGroup = {
		length: match.length,
		rep: match.a,
		members: new Map([
			[`${match.a.file}:${match.a.start}`, match.a],
			[`${match.b.file}:${match.b.start}`, match.b],
		]),
	};
	candidates.push(group);
	byLength.set(match.length, candidates);
}

/** `31 ** DUPLICATION_MIN_TOKENS` mod 2³², the rolling-hash drop factor (imul arithmetic). */
const ROLLING_POWER = (() => {
	let power = 1;
	for (let index = 0; index < DUPLICATION_MIN_TOKENS; index += 1) power = Math.imul(power, 31);
	return power;
})();

/** The polynomial hash of the K-token window at `start`. */
function initialHash(kinds: readonly ts.SyntaxKind[], start: number): number {
	let hash = 0;
	for (let offset = 0; offset < DUPLICATION_MIN_TOKENS; offset += 1) {
		hash = (Math.imul(hash, 31) + (kinds[start + offset] ?? 0)) | 0;
	}
	return hash;
}

/** Roll the window hash one position forward: (h − old·31^(K−1))·31 + new, in wrapping imul arithmetic. */
function rollHash(kinds: readonly ts.SyntaxKind[], position: number, hash: number): number {
	return (
		(Math.imul(hash, 31) -
			Math.imul(kinds[position - 1] ?? 0, ROLLING_POWER) +
			(kinds[position + DUPLICATION_MIN_TOKENS - 1] ?? 0)) |
		0
	);
}

/** Collect every K-token window hash of one file into the map (never crossing file boundaries). */
function collectFileWindows(
	data: Concatenated,
	file: number,
	windows: Map<number, number[]>,
): void {
	const start = data.fileStart[file] ?? 0;
	const last = (data.fileEnd[file] ?? 0) - DUPLICATION_MIN_TOKENS;
	if (last < start) return;
	let hash = initialHash(data.kinds, start);
	for (let position = start; position <= last; position += 1) {
		if (position > start) hash = rollHash(data.kinds, position, hash);
		const positions = windows.get(hash);
		if (positions === undefined) windows.set(hash, [position]);
		else positions.push(position);
	}
}

/** Map every K-token window hash to its start positions (per file, never crossing boundaries). */
function buildWindows(data: Concatenated): Map<number, number[]> {
	const windows = new Map<number, number[]>();
	for (const file of data.fileStart.keys()) collectFileWindows(data, file, windows);
	return windows;
}

/** Extend one pair of window positions into the raw groups; returns false when the budget tripped. */
function extendPair(
	data: Concatenated,
	byLength: Map<number, RawGroup[]>,
	pa: number,
	pb: number,
	work: WorkState,
	budget: DuplicationBudget,
): boolean {
	const match = extendMatch(data, pa, pb, work, budget);
	if (work.exhausted) return false;
	if (match !== null) addMatch(byLength, data.kinds, match, work, budget);
	return !work.exhausted;
}

/** Extend every pair of one window-hash equivalence class; returns false when the budget tripped. */
function extendClass(
	data: Concatenated,
	byLength: Map<number, RawGroup[]>,
	positions: readonly number[],
	work: WorkState,
	budget: DuplicationBudget,
): boolean {
	for (let a = 0; a < positions.length; a += 1) {
		for (let b = a + 1; b < positions.length; b += 1) {
			const pa = positions[a];
			const pb = positions[b];
			if (pa === undefined || pb === undefined) continue;
			if (!extendPair(data, byLength, pa, pb, work, budget)) return false;
		}
	}
	return true;
}

/** Extend every pair of equal-hash windows and merge matches into raw groups by content identity. */
function collectRawGroups(
	data: Concatenated,
	windows: Map<number, number[]>,
	work: WorkState,
	budget: DuplicationBudget,
): Map<number, RawGroup[]> {
	const byLength = new Map<number, RawGroup[]>();
	for (const positions of windows.values()) {
		if (positions.length < 2) continue;
		if (!extendClass(data, byLength, positions, work, budget)) break;
	}
	return byLength;
}

/**
 * Detect clone groups in one source set's token streams (see the
 * `duplication.ts` module docblock for the full semantics). Pure and
 * synchronous; deterministic for a fixed stream order. Budget exhaustion
 * returns the groups found so far plus the tripped {@link BudgetExhaustion}
 * — never a silent clean result.
 */
export function detectClones(
	streams: readonly TokenStream[],
	budget: DuplicationBudget = DEFAULT_DUPLICATION_BUDGET,
): CloneDetection {
	const data = concatenate(streams);
	if (data.kinds.length > budget.maxTokens) {
		return {
			groups: [],
			tokenCount: data.kinds.length,
			exhaustion: { kind: "token-count", limit: budget.maxTokens },
		};
	}
	const work: WorkState = { count: 0, exhausted: false };
	const byLength = collectRawGroups(data, buildWindows(data), work, budget);
	return {
		groups: finalizeGroups(byLength, streams, data.fileStart),
		tokenCount: data.kinds.length,
		exhaustion: work.exhausted ? { kind: "match-work", limit: budget.maxMatchWork } : null,
	};
}
