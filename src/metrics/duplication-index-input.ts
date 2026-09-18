/** Exact integer alphabet ranking with distinct file terminators; candidate only. */
import type { TokenStream } from "./duplication.ts";
import type { DuplicationWork } from "./duplication-work.ts";

export interface RankedTokens {
	tokens: Uint32Array;
	fileOf: Uint32Array;
	fileStart: Uint32Array;
	fileEnd: Uint32Array;
	tokenCount: number;
	alphabetSize: number;
}

function preflight(streams: readonly TokenStream[], work: DuplicationWork): number {
	work.enter("input");
	if (streams.length > work.limits.maxStreams) work.stop("maxStreams", work.limits.maxStreams);
	let count = 0;
	for (const stream of streams) {
		work.charge();
		count += stream.kinds.length;
		if (count > work.limits.maxTokens) work.stop("maxTokens", work.limits.maxTokens);
	}
	return count;
}

function alphabet(streams: readonly TokenStream[], work: DuplicationWork): Map<number, number> {
	const ranks = new Map<number, number>();
	for (const stream of streams) {
		work.charge();
		for (const kind of stream.kinds) {
			work.charge();
			if (!Number.isInteger(kind) || kind < 0 || kind > 0x7fffffff) {
				throw new RangeError("Expected nonnegative integer token kinds");
			}
			if (!ranks.has(kind)) {
				work.reserve(2);
				ranks.set(kind, 0);
			}
		}
	}
	const keys = work.array(ranks.size);
	let cursor = 0;
	for (const key of ranks.keys()) {
		work.charge();
		keys[cursor++] = key;
	}
	keys.sort((a, b) => {
		work.charge();
		return a - b;
	});
	for (let i = 0; i < keys.length; i += 1) {
		work.charge();
		ranks.set(keys[i] ?? 0, streams.length + i + 1);
	}
	work.release(keys.length);
	return ranks;
}

export function rankTokenStreams(
	streams: readonly TokenStream[],
	work: DuplicationWork,
): RankedTokens {
	const tokenCount = preflight(streams, work);
	const ranks = alphabet(streams, work);
	const length = tokenCount + streams.length;
	const tokens = work.array(length);
	const fileOf = work.array(length);
	const fileStart = work.array(streams.length);
	const fileEnd = work.array(streams.length);
	let cursor = 0;
	for (const [file, stream] of streams.entries()) {
		work.charge(4);
		fileStart[file] = cursor;
		for (const kind of stream.kinds) {
			work.charge(4);
			tokens[cursor] = ranks.get(kind) ?? 0;
			fileOf[cursor++] = file;
		}
		fileEnd[file] = cursor;
		tokens[cursor] = file + 1;
		fileOf[cursor++] = file;
	}
	work.release(ranks.size * 2);
	work.checkpoint();
	return {
		tokens,
		fileOf,
		fileStart,
		fileEnd,
		tokenCount,
		alphabetSize: ranks.size + streams.length,
	};
}
