/** Preserve the old stable-sort tie order without using hashes to detect clones.
 * The legacy engine discovered groups by first-seen 100-token hash bucket,
 * then by the first maximal pair's positions. Only ordinal compatibility uses
 * that key; suffix/LCP content and context checks remain authoritative.
 */
import { DUPLICATION_MIN_TOKENS, type TokenStream } from "./duplication.ts";
import type { RawGroup, RawMember } from "./duplication-groups.ts";
import type { RankedTokens } from "./duplication-index-input.ts";
import type { DuplicationWork } from "./duplication-work.ts";

type Order = readonly [number, number, number];
const EMPTY_ORDER: Order = [0, 0, 0];

function windowFactor(work: DuplicationWork): number {
	let factor = 1;
	for (let i = 0; i < DUPLICATION_MIN_TOKENS; i += 1) {
		work.charge();
		factor = Math.imul(factor, 31);
	}
	return factor;
}

function windowOrders(streams: readonly TokenStream[], data: RankedTokens, work: DuplicationWork) {
	const hashes = work.array(data.tokens.length);
	const first = new Map<number, number>();
	const factor = windowFactor(work);
	for (const [file, stream] of streams.entries()) {
		work.charge();
		let hash = 0;
		for (let index = 0; index < stream.kinds.length; index += 1) {
			work.charge(6);
			hash = (Math.imul(hash, 31) + (stream.kinds[index] ?? 0)) | 0;
			if (index >= DUPLICATION_MIN_TOKENS)
				hash = (hash - Math.imul(stream.kinds[index - DUPLICATION_MIN_TOKENS] ?? 0, factor)) | 0;
			if (index + 1 < DUPLICATION_MIN_TOKENS) continue;
			const position = (data.fileStart[file] ?? 0) + index + 1 - DUPLICATION_MIN_TOKENS;
			const unsigned = hash >>> 0;
			hashes[position] = unsigned;
			if (!first.has(unsigned)) {
				work.reserve(2);
				first.set(unsigned, position);
			}
		}
	}
	return { hashes, first };
}

function leftContext(member: RawMember, data: RankedTokens): number {
	return member.start === data.fileStart[member.file]
		? -member.file - 1
		: (data.tokens[member.start - 1] ?? 0);
}

function firstPartner(group: RawGroup, data: RankedTokens, work: DuplicationWork): number {
	const repLeft = leftContext(group.rep, data);
	const repRight = data.tokens[group.rep.end];
	let partner = Infinity;
	for (const member of group.members.values()) {
		work.charge(6);
		if (leftContext(member, data) !== repLeft && data.tokens[member.end] !== repRight) {
			partner = Math.min(partner, member.start);
		}
	}
	return partner;
}

function groupOrder(
	group: RawGroup,
	data: RankedTokens,
	hashes: Uint32Array,
	first: Map<number, number>,
	work: DuplicationWork,
): Order {
	let bucket = Infinity;
	let offset = 0;
	for (let i = 0; i <= group.length - DUPLICATION_MIN_TOKENS; i += 1) {
		work.charge(3);
		const order = first.get(hashes[group.rep.start + i] ?? 0) ?? Infinity;
		if (order < bucket) {
			bucket = order;
			offset = i;
		}
	}
	return [bucket, group.rep.start + offset, firstPartner(group, data, work) + offset];
}

export function orderRawGroups(
	groups: Map<number, RawGroup[]>,
	streams: readonly TokenStream[],
	data: RankedTokens,
	work: DuplicationWork,
): void {
	const { hashes, first } = windowOrders(streams, data, work);
	for (const sameLength of groups.values()) {
		work.charge();
		const keys = new Map<RawGroup, Order>();
		for (const group of sameLength) {
			work.reserve(3);
			keys.set(group, groupOrder(group, data, hashes, first, work));
		}
		sameLength.sort((a, b) => {
			work.charge(7);
			const x = keys.get(a) ?? EMPTY_ORDER;
			const y = keys.get(b) ?? EMPTY_ORDER;
			return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
		});
		work.release(keys.size * 3);
	}
	work.release(hashes.length + first.size * 2);
	work.checkpoint();
}
