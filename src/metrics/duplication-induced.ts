/** Original SA-IS implementation: induced L/S sorting with LMS substring naming.
 * The reduced problem has at most half the input length, bounding recursion by
 * log2(n). No Fallow or other implementation source is copied. Numeric scans,
 * comparisons and allocations all use the frozen candidate work guard.
 */
import type { DuplicationWork } from "./duplication-work.ts";

const EMPTY = 0xffffffff;
interface State {
	tokens: Uint32Array;
	types: Uint32Array;
	counts: Uint32Array;
	buckets: Uint32Array;
	sa: Uint32Array;
}

function prepare(tokens: Uint32Array, upper: number, work: DuplicationWork): State {
	const types = work.array(tokens.length);
	const counts = work.array(upper + 1);
	const buckets = work.array(upper + 1);
	const sa = work.array(tokens.length);
	work.charge();
	types[tokens.length - 1] = 1;
	for (let i = tokens.length - 2; i >= 0; i -= 1) {
		work.charge(5);
		const current = tokens[i] ?? 0;
		const next = tokens[i + 1] ?? 0;
		types[i] = current < next || (current === next && types[i + 1] === 1) ? 1 : 0;
	}
	for (const token of tokens) {
		work.charge(3);
		counts[token] = (counts[token] ?? 0) + 1;
	}
	return { tokens, types, counts, buckets, sa };
}

function resetBuckets(state: State, end: boolean, work: DuplicationWork): void {
	let offset = 0;
	for (let i = 0; i < state.counts.length; i += 1) {
		work.charge(2);
		const count = state.counts[i] ?? 0;
		state.buckets[i] = end ? offset + count : offset;
		offset += count;
	}
}

function inducePredecessor(
	state: State,
	position: number,
	isSmall: boolean,
	work: DuplicationWork,
): void {
	if (position === EMPTY || position === 0 || (state.types[position - 1] === 1) !== isSmall) return;
	work.charge(4);
	const token = state.tokens[position - 1] ?? 0;
	const slot = (state.buckets[token] ?? 0) - (isSmall ? 1 : 0);
	state.sa[slot] = position - 1;
	state.buckets[token] = slot + (isSmall ? 0 : 1);
}

function induceSide(state: State, isSmall: boolean, work: DuplicationWork): void {
	resetBuckets(state, isSmall, work);
	const direction = isSmall ? -1 : 1;
	for (let i = isSmall ? state.sa.length - 1 : 0; i >= 0 && i < state.sa.length; i += direction) {
		work.charge(2);
		const position = state.sa[i] ?? EMPTY;
		inducePredecessor(state, position, isSmall, work);
	}
}

function induce(state: State, lms: Uint32Array, work: DuplicationWork): void {
	for (let i = 0; i < state.sa.length; i += 1) {
		work.charge();
		state.sa[i] = EMPTY;
	}
	resetBuckets(state, true, work);
	for (let i = lms.length - 1; i >= 0; i -= 1) {
		work.charge(5);
		const position = lms[i] ?? 0;
		const token = state.tokens[position] ?? 0;
		const slot = (state.buckets[token] ?? 0) - 1;
		state.buckets[token] = slot;
		state.sa[slot] = position;
	}
	induceSide(state, false, work);
	induceSide(state, true, work);
}

function lmsPositions(types: Uint32Array, work: DuplicationWork): Uint32Array {
	let count = 0;
	for (let i = 1; i < types.length; i += 1) {
		work.charge(2);
		if (types[i] === 1 && types[i - 1] === 0) count++;
	}
	const positions = work.array(count);
	let cursor = 0;
	for (let i = 1; i < types.length; i += 1) {
		work.charge(3);
		if (types[i] === 1 && types[i - 1] === 0) positions[cursor++] = i;
	}
	return positions;
}

function sameSubstring(
	a: number,
	b: number,
	state: State,
	ordinal: Uint32Array,
	work: DuplicationWork,
): boolean {
	for (let offset = 0; ; offset += 1) {
		work.charge(7);
		if (
			state.tokens[a + offset] !== state.tokens[b + offset] ||
			state.types[a + offset] !== state.types[b + offset]
		)
			return false;
		if (offset > 0) {
			const left = (ordinal[a + offset] ?? 0) > 0;
			const right = (ordinal[b + offset] ?? 0) > 0;
			if (left || right) return left && right;
		}
	}
}

function nameSubstrings(state: State, lms: Uint32Array, work: DuplicationWork) {
	const ordinal = work.array(state.tokens.length);
	for (let i = 0; i < lms.length; i += 1) {
		work.charge(2);
		ordinal[lms[i] ?? 0] = i + 1;
	}
	const reduced = work.array(lms.length);
	let name = -1;
	let previous = -1;
	for (const position of state.sa) {
		work.charge(2);
		const index = ordinal[position] ?? 0;
		if (index === 0) continue;
		if (previous < 0 || !sameSubstring(previous, position, state, ordinal, work)) name += 1;
		work.charge();
		reduced[index - 1] = name;
		previous = position;
	}
	work.release(ordinal.length);
	return { reduced, names: name + 1 };
}

/** Input ends in a unique zero sentinel; every other token is positive. */
export function inducedSuffixes(
	tokens: Uint32Array,
	upper: number,
	work: DuplicationWork,
): Uint32Array {
	if (tokens.length === 1) return work.array(1);
	const state = prepare(tokens, upper, work);
	const lms = lmsPositions(state.types, work);
	induce(state, lms, work);
	const { reduced, names } = nameSubstrings(state, lms, work);
	let reducedSa: Uint32Array;
	if (names === reduced.length) {
		reducedSa = work.array(reduced.length);
		for (let i = 0; i < reduced.length; i += 1) {
			work.charge(2);
			reducedSa[reduced[i] ?? 0] = i;
		}
	} else reducedSa = inducedSuffixes(reduced, names - 1, work);
	const ordered = work.array(lms.length);
	for (let i = 0; i < ordered.length; i += 1) {
		work.charge(3);
		ordered[i] = lms[reducedSa[i] ?? 0] ?? 0;
	}
	work.release(reduced.length + reducedSa.length);
	induce(state, ordered, work);
	work.release(
		state.types.length + state.counts.length + state.buckets.length + lms.length + ordered.length,
	);
	return state.sa;
}
