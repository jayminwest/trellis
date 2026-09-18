/** Iterative prefix doubling, stable counting sort: O(n log n) work, O(n) cells.
 * Original implementation, no Fallow source port. Every numeric pass is charged
 * conservatively for all slot reads/writes, plus rank-pair comparisons.
 */
import type { DuplicationWork } from "./duplication-work.ts";

function countSort(
	input: Uint32Array,
	output: Uint32Array,
	ranks: Uint32Array,
	counts: Uint32Array,
	classes: number,
	work: DuplicationWork,
): void {
	for (let i = 0; i <= classes; i += 1) {
		work.charge();
		counts[i] = 0;
	}
	for (const position of input) {
		work.charge(4);
		const rank = ranks[position] ?? 0;
		counts[rank] = (counts[rank] ?? 0) + 1;
	}
	let offset = 0;
	for (let i = 0; i <= classes; i += 1) {
		work.charge(2);
		const count = counts[i] ?? 0;
		counts[i] = offset;
		offset += count;
	}
	for (const position of input) {
		work.charge(5);
		const rank = ranks[position] ?? 0;
		const target = counts[rank] ?? 0;
		output[target] = position;
		counts[rank] = target + 1;
	}
}

function shiftedOrder(
	sa: Uint32Array,
	target: Uint32Array,
	span: number,
	work: DuplicationWork,
): void {
	let cursor = 0;
	for (let i = Math.max(0, sa.length - span); i < sa.length; i += 1) {
		work.charge();
		target[cursor++] = i;
	}
	for (const position of sa) {
		work.charge(2);
		if (position >= span) target[cursor++] = position - span;
	}
}

function rerank(
	sa: Uint32Array,
	ranks: Uint32Array,
	target: Uint32Array,
	span: number,
	work: DuplicationWork,
): number {
	let classes = 0;
	let previous = -1;
	for (const position of sa) {
		work.charge(8);
		if (
			previous < 0 ||
			ranks[position] !== ranks[previous] ||
			(ranks[position + span] ?? 0) !== (ranks[previous + span] ?? 0)
		)
			classes += 1;
		target[position] = classes;
		previous = position;
	}
	return classes;
}

export function suffixArray(
	tokens: Uint32Array,
	alphabetSize: number,
	work: DuplicationWork,
): Uint32Array {
	work.enter("index");
	const length = tokens.length;
	const sa = work.array(length);
	const order = work.array(length);
	let ranks = work.array(length);
	let next = work.array(length);
	const counts = work.array(Math.max(length, alphabetSize) + 1);
	for (let i = 0; i < length; i += 1) {
		work.charge(3);
		ranks[i] = tokens[i] ?? 0;
		order[i] = i;
	}
	countSort(order, sa, ranks, counts, alphabetSize, work);
	let classes = alphabetSize;
	for (let span = 1; span < length && classes < length; span *= 2) {
		shiftedOrder(sa, order, span, work);
		countSort(order, sa, ranks, counts, classes, work);
		classes = rerank(sa, ranks, next, span, work);
		[ranks, next] = [next, ranks];
	}
	work.release(order.length + ranks.length + next.length + counts.length);
	work.checkpoint();
	return sa;
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
		while (position + common < tokens.length && previous + common < tokens.length) {
			work.charge(3);
			if (tokens[position + common] !== tokens[previous + common]) break;
			common += 1;
		}
		lcp[rank] = common;
		if (common > 0) common -= 1;
	}
	work.release(inverse.length);
	work.checkpoint();
	return lcp;
}
