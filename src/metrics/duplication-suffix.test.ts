import { describe, expect, test } from "bun:test";
import { rankTokenStreams } from "./duplication-index-input.ts";
import { longestCommonPrefixes, suffixArray } from "./duplication-suffix.ts";
import { DuplicationLimitError, DuplicationWork } from "./duplication-work.ts";
import { syntheticStream } from "./tests/duplication-fixtures.ts";

function verify(streams: number[][]): void {
	const work = new DuplicationWork();
	const data = rankTokenStreams(
		streams.map((kinds, i) => syntheticStream(`${i}.ts`, kinds)),
		work,
	);
	const sa = suffixArray(data.tokens, data.alphabetSize, work);
	const lcp = longestCommonPrefixes(data.tokens, sa, work);
	const expected = Array.from(data.tokens.keys()).sort((a, b) => {
		while (a < data.tokens.length && b < data.tokens.length) {
			const difference = (data.tokens[a++] ?? 0) - (data.tokens[b++] ?? 0);
			if (difference !== 0) return difference;
		}
		return b - a;
	});
	expect([...sa]).toEqual(expected);
	for (let rank = 0; rank < sa.length; rank += 1) {
		const position = sa[rank] ?? 0;
		const previous = sa[rank - 1] ?? 0;
		let common = 0;
		while (
			rank > 0 &&
			position + common < data.tokens.length &&
			previous + common < data.tokens.length &&
			data.tokens[position + common] === data.tokens[previous + common]
		)
			common += 1;
		expect(lcp[rank]).toBe(common);
		const file = data.fileOf[position] ?? 0;
		expect(position + common).toBeLessThanOrEqual(data.fileEnd[file] ?? 0);
	}
	expect(data.tokenCount).toBe(streams.reduce((sum, stream) => sum + stream.length, 0));
	expect(work.liveCells).toBe(data.tokens.length * 4 + streams.length * 2);
	expect(work.counts.input).toBeGreaterThanOrEqual(data.tokenCount);
}

describe("suffixArray", () => {
	test("orders empty, singleton, equal-prefix, periodic and repeated-kind streams", () => {
		for (const streams of [
			[],
			[[]],
			[[], [], []],
			[[0]],
			[[9, 9, 9]],
			[[0, 1, 0, 1, 0, 1]],
			[[1, 2], [1, 2, 3], [], [1, 2]],
			[
				[0x7fffffff, 0],
				[0, 0x7fffffff],
			],
			[[8, 7, 6, 5]],
		])
			verify(streams);
	});

	test("matches exhaustive ordering and LCP for fixed-seed generated streams", () => {
		let state = 0x19a87;
		const next = () => {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			return state;
		};
		for (let trial = 0; trial < 250; trial += 1) {
			verify(
				Array.from({ length: next() % 7 }, () =>
					Array.from({ length: next() % 45 }, () => next() % 13),
				),
			);
		}
	});

	test("keeps unique boundaries outside the full integer token alphabet", () => {
		const work = new DuplicationWork();
		const data = rankTokenStreams(
			[syntheticStream("a", [0, 2]), syntheticStream("b", [0, 2])],
			work,
		);
		expect([...data.tokens]).toEqual([3, 4, 1, 3, 4, 2]);
		expect([...data.fileStart]).toEqual([0, 3]);
		expect([...data.fileEnd]).toEqual([2, 5]);
		expect([...data.fileOf]).toEqual([0, 0, 0, 1, 1, 1]);
		const sa = suffixArray(data.tokens, data.alphabetSize, work);
		expect(Math.max(...longestCommonPrefixes(data.tokens, sa, work))).toBe(2);
	});

	test("rejects oversized input before allocating combined arrays", () => {
		for (const limits of [{ maxTokens: 2 }, { maxStreams: 0 }]) {
			const work = new DuplicationWork(limits);
			expect(() => rankTokenStreams([syntheticStream("a", [1, 2, 3])], work)).toThrow(
				DuplicationLimitError,
			);
			expect(work.peakCells).toBe(0);
		}
	});

	test("rejects malformed token kinds without treating them as sentinels", () => {
		for (const kind of [-1, 0.5, NaN, Infinity, 0x80000000]) {
			expect(() => rankTokenStreams([syntheticStream("a", [kind])], new DuplicationWork())).toThrow(
				RangeError,
			);
		}
	});

	test("fails deterministically on index work and numeric allocation limits", () => {
		const run = () => {
			const work = new DuplicationWork({ phaseLimits: { index: 30 } });
			const data = rankTokenStreams([syntheticStream("a", [1, 1, 1, 1])], work);
			try {
				suffixArray(data.tokens, data.alphabetSize, work);
			} catch (error) {
				if (!(error instanceof DuplicationLimitError)) throw error;
				return { exhaustion: error.exhaustion, counts: work.counts };
			}
			throw new Error("Expected exhaustion");
		};
		expect(run()).toEqual(run());
		expect(run().exhaustion).toEqual({ phase: "index", kind: "phase-work", limit: 30 });
		expect(() =>
			suffixArray(new Uint32Array([1]), 1, new DuplicationWork({ maxWorkingCells: 0 })),
		).toThrow(DuplicationLimitError);
	});
});
