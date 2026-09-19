/** Bounded suffix-array/LCP primitives; induced sorting replaces prefix doubling
 * after the pinned Zod acceptance probe exceeded the frozen work ceiling.
 */

import { inducedSuffixes } from "./duplication-induced.ts";
import type { DuplicationWork } from "./duplication-work.ts";

export function suffixArray(
	tokens: Uint32Array,
	alphabetSize: number,
	work: DuplicationWork,
): Uint32Array {
	work.enter("index");
	const terminated = work.array(tokens.length + 1);
	for (let i = 0; i < tokens.length; i += 1) {
		work.charge(2);
		terminated[i] = tokens[i] ?? 0;
	}
	const full = inducedSuffixes(terminated, alphabetSize, work);
	const sa = work.array(tokens.length);
	for (let i = 0; i < sa.length; i += 1) {
		work.charge(2);
		sa[i] = full[i + 1] ?? 0;
	}
	work.release(terminated.length + full.length);
	work.checkpoint();
	return sa;
}

function extendPrefix(
	tokens: Uint32Array,
	position: number,
	previous: number,
	common: number,
	work: DuplicationWork,
): number {
	while (position + common < tokens.length && previous + common < tokens.length) {
		work.charge(3);
		if (tokens[position + common] !== tokens[previous + common]) break;
		common += 1;
	}
	return common;
}

/** Kasai's linear LCP; distinct terminators force mismatch at every file boundary. */
export function longestCommonPrefixes(
	tokens: Uint32Array,
	sa: Uint32Array,
	work: DuplicationWork,
): Uint32Array {
	work.enter("index");
	const inverse = work.array(sa.length);
	const lcp = work.array(sa.length);
	for (let rank = 0; rank < sa.length; rank += 1) {
		work.charge(2);
		inverse[sa[rank] ?? 0] = rank;
	}
	let common = 0;
	for (let position = 0; position < tokens.length; position += 1) {
		work.charge(3);
		const rank = inverse[position] ?? 0;
		if (rank === 0) {
			common = 0;
			continue;
		}
		const previous = sa[rank - 1] ?? 0;
		common = extendPrefix(tokens, position, previous, common, work);
		lcp[rank] = common;
		if (common > 0) common -= 1;
	}
	work.release(inverse.length);
	work.checkpoint();
	return lcp;
}
