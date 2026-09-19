/** Maximal LCP intervals, with linear context counting instead of occurrence pairs.
 * A member participates exactly when another occurrence differs on BOTH sides.
 * Inclusion/exclusion of left/right context counts tests that without a Cartesian product.
 */
import { DUPLICATION_MIN_TOKENS } from "./duplication.ts";
import type { RawGroup, RawMember } from "./duplication-groups.ts";
import type { RankedTokens } from "./duplication-index-input.ts";
import type { DuplicationWork } from "./duplication-work.ts";

interface ContextCounts {
	left: Map<number, number>;
	right: Map<number, number>;
	pairs: Map<string, number>;
}

function contexts(data: RankedTokens, position: number, length: number, work: DuplicationWork) {
	work.charge(5);
	const file = data.fileOf[position] ?? 0;
	const left = position === data.fileStart[file] ? -file - 1 : (data.tokens[position - 1] ?? 0);
	const right = data.tokens[position + length] ?? 0;
	return { left, right, pair: `${left}:${right}` };
}

function increment<Key>(map: Map<Key, number>, key: Key, work: DuplicationWork): void {
	work.charge(2);
	const previous = map.get(key);
	if (previous === undefined) work.reserve(2);
	map.set(key, (previous ?? 0) + 1);
}

function countContexts(
	data: RankedTokens,
	sa: Uint32Array,
	begin: number,
	end: number,
	length: number,
	work: DuplicationWork,
): ContextCounts {
	const counts: ContextCounts = { left: new Map(), right: new Map(), pairs: new Map() };
	for (let rank = begin; rank < end; rank += 1) {
		work.charge();
		const context = contexts(data, sa[rank] ?? 0, length, work);
		increment(counts.left, context.left, work);
		increment(counts.right, context.right, work);
		increment(counts.pairs, context.pair, work);
	}
	return counts;
}

function memberAt(data: RankedTokens, start: number, length: number): RawMember {
	return { file: data.fileOf[start] ?? 0, start, end: start + length };
}

function intervalMembers(
	data: RankedTokens,
	sa: Uint32Array,
	begin: number,
	end: number,
	length: number,
	counts: ContextCounts,
	work: DuplicationWork,
): RawGroup | undefined {
	let group: RawGroup | undefined;
	for (let rank = begin; rank < end; rank += 1) {
		work.charge(5);
		const start = sa[rank] ?? 0;
		const { left, right, pair } = contexts(data, start, length, work);
		const partners =
			end -
			begin -
			(counts.left.get(left) ?? 0) -
			(counts.right.get(right) ?? 0) +
			(counts.pairs.get(pair) ?? 0);
		if (partners === 0) continue;
		work.retainOccurrence();
		const member = memberAt(data, start, length);
		if (group === undefined) {
			work.retainGroup();
			group = { length, rep: member, members: new Map() };
		}
		if (member.start < group.rep.start) group.rep = member;
		group.members.set(`${member.file}:${member.start}`, member);
	}
	return group;
}

function emitInterval(
	data: RankedTokens,
	sa: Uint32Array,
	begin: number,
	end: number,
	length: number,
	groups: Map<number, RawGroup[]>,
	work: DuplicationWork,
): void {
	work.charge();
	const counts = countContexts(data, sa, begin, end, length, work);
	const group = intervalMembers(data, sa, begin, end, length, counts, work);
	work.release(2 * (counts.left.size + counts.right.size + counts.pairs.size));
	if (group !== undefined) {
		work.charge();
		const sameLength = groups.get(length) ?? [];
		sameLength.push(group);
		groups.set(length, sameLength);
	}
}

interface IntervalStack {
	starts: Uint32Array;
	depths: Uint32Array;
	size: number;
}

function closeIntervals(
	stack: IntervalStack,
	depth: number,
	rank: number,
	data: RankedTokens,
	sa: Uint32Array,
	groups: Map<number, RawGroup[]>,
	work: DuplicationWork,
): number {
	let begin = rank - 1;
	while (stack.size > 0 && (stack.depths[stack.size - 1] ?? 0) > depth) {
		work.charge(3);
		stack.size -= 1;
		begin = stack.starts[stack.size] ?? 0;
		emitInterval(data, sa, begin, rank, stack.depths[stack.size] ?? 0, groups, work);
	}
	return begin;
}

/** A single stack sweep visits every branching LCP interval once. */
export function extractCloneGroups(
	data: RankedTokens,
	sa: Uint32Array,
	lcp: Uint32Array,
	work: DuplicationWork,
): Map<number, RawGroup[]> {
	work.enter("extraction");
	const starts = work.array(sa.length);
	const depths = work.array(sa.length);
	const groups = new Map<number, RawGroup[]>();
	const stack: IntervalStack = { starts, depths, size: 0 };
	for (let rank = 1; rank <= sa.length; rank += 1) {
		work.charge(3);
		const depth = lcp[rank] ?? 0;
		const begin = closeIntervals(stack, depth, rank, data, sa, groups, work);
		if (
			depth >= DUPLICATION_MIN_TOKENS &&
			(stack.size === 0 || (depths[stack.size - 1] ?? 0) < depth)
		) {
			work.charge(2);
			starts[stack.size] = begin;
			depths[stack.size++] = depth;
		}
	}
	work.release(starts.length + depths.length);
	work.checkpoint();
	return groups;
}
