import { describe, expect, test } from "bun:test";
import { collectTokenStream, type TokenStream } from "./duplication.ts";
import { extractCloneGroups } from "./duplication-extract.ts";
import { finalizeCandidateGroups } from "./duplication-finalize.ts";
import { rankTokenStreams } from "./duplication-index-input.ts";
import { orderRawGroups } from "./duplication-order.ts";
import { longestCommonPrefixes, suffixArray } from "./duplication-suffix.ts";
import {
	DuplicationLimitError,
	DuplicationWork,
	type DuplicationWorkOptions,
} from "./duplication-work.ts";
import {
	repeatedSource,
	repeatedStreams,
	sourceFile,
	syntheticStream,
} from "./tests/duplication-fixtures.ts";
import { type ReferenceGroup, referenceDetection } from "./tests/duplication-oracle.ts";
import { detectClones } from "./tests/legacy-duplication.ts";
import { finalizeGroups } from "./tests/legacy-duplication-groups.ts";

function candidate(streams: TokenStream[], options: DuplicationWorkOptions = {}) {
	const work = new DuplicationWork(options);
	const data = rankTokenStreams(streams, work);
	const sa = suffixArray(data.tokens, data.alphabetSize, work);
	const lcp = longestCommonPrefixes(data.tokens, sa, work);
	const raw = extractCloneGroups(data, sa, lcp, work);
	orderRawGroups(raw, streams, data, work);
	const groups = finalizeGroups(raw, streams, [...data.fileStart]);
	expect(finalizeCandidateGroups(raw, streams, data.fileStart, work)).toEqual(groups);
	const referenceRaw: ReferenceGroup[] = [...raw.values()].flat().map((group) => {
		const stream = streams[group.rep.file];
		const start = group.rep.start - (data.fileStart[group.rep.file] ?? 0);
		const tokens = stream?.kinds.slice(start, start + group.length) ?? [];
		const members = [...group.members.values()].map((member) => {
			const file = streams[member.file];
			const local = member.start - (data.fileStart[member.file] ?? 0);
			expect(file?.kinds.slice(local, local + group.length)).toEqual(tokens);
			return { path: file?.path ?? "", start: local, end: local + group.length };
		});
		return { tokens, members };
	});
	return { groups, raw: referenceRaw, work };
}

function canonical(raw: ReferenceGroup[]) {
	return raw
		.map((group) => ({
			...group,
			members: group.members.sort((a, b) => a.path.localeCompare(b.path) || a.start - b.start),
		}))
		.sort((a, b) => JSON.stringify(a.tokens).localeCompare(JSON.stringify(b.tokens)));
}

function parity(streams: TokenStream[]) {
	const actual = candidate(streams);
	const expected = referenceDetection(streams);
	expect(canonical(actual.raw)).toEqual(canonical(expected.raw));

	const legacy = detectClones(streams);
	expect(legacy.exhaustion).toBeNull();
	const payloads = (groups: typeof actual.groups) =>
		groups
			.map(({ id: _id, ...group }) =>
				JSON.stringify(group, [
					"tokenCount",
					"members",
					"path",
					"range",
					"start",
					"end",
					"line",
					"lineCount",
				]),
			)
			.sort();
	expect(payloads(actual.groups)).toEqual(payloads(expected.groups));
	expect(actual.groups).toEqual(legacy.groups);
	return actual;
}

describe("extractCloneGroups", () => {
	test("preserves threshold, empty, boundary and same-file periodic semantics", () => {
		for (const length of [0, 1, 99, 100, 101]) {
			const kinds = Array.from({ length }, (_, i) => i);
			parity([
				syntheticStream("a", kinds),
				syntheticStream("b", kinds),
				syntheticStream("empty", []),
			]);
		}
		for (const period of [1, 3, 11]) {
			parity([
				syntheticStream(
					"a",
					Array.from({ length: 211 }, (_, i) => i % period),
					15,
				),
			]);
		}
		parity([]);
		const run = Array.from({ length: 100 }, (_, i) => i);
		parity([syntheticStream("a", run, 2), syntheticStream("b", run, 3)]);
		parity([
			syntheticStream("a", run.slice(0, 50)),
			syntheticStream("b", run.slice(50)),
			syntheticStream("c", run),
		]);
	});

	test("excludes occurrences that have no partner differing on both sides", () => {
		const run = Array.from({ length: 100 }, (_, i) => i + 10);
		// The (1,3) occurrence has neither a left-and-right divergent partner;
		// (1,2) and (4,3) do. A mere left-diversity test would incorrectly retain it.
		const result = parity(
			[
				[1, ...run, 2],
				[1, ...run, 3],
				[4, ...run, 3],
			].map((kinds, i) => syntheticStream(`${i}`, kinds, 8)),
		);
		const central = result.raw.find((group) => group.tokens.length === 100);
		expect(central?.members.map((member) => member.path)).toEqual(["0", "2"]);
	});

	test("separates divergent maximal branches and preserves input-order independence", () => {
		const first = Array.from({ length: 100 }, (_, i) => i + 1);
		const second = first.map((kind) => kind + 110);
		const streams = [
			syntheticStream("a", [...first, ...second], 8),
			syntheticStream("b", [...first, 250], 4),
			syntheticStream("c", [251, ...second], 4),
		];
		expect(parity(streams).groups).toEqual(parity([...streams].reverse()).groups);
	});

	test("matches exact, renamed, edited and nested real-source clones", () => {
		const original = repeatedSource("alpha");
		const rename = original.replaceAll("alpha", "beta").replaceAll(/\bx\b/g, "value");
		for (const text of [
			original,
			rename,
			rename.replace("return 13;", "console.log(value); return 13;"),
		]) {
			parity([
				collectTokenStream(sourceFile("a", original)),
				collectTokenStream(sourceFile("b", text)),
			]);
		}
		for (const copies of [2, 10]) parity(repeatedStreams(copies));
	});

	test("completes forty copies as one maximal group with every exact member", () => {
		const result = candidate(repeatedStreams(40));
		expect(result.groups).toHaveLength(1);
		expect(result.groups[0]?.tokenCount).toBe(229);
		expect(result.groups[0]?.members).toHaveLength(40);
		expect(result.groups[0]?.members.reduce((lines, member) => lines + member.lineCount, 0)).toBe(
			1080,
		);
		expect(result.work.total).toBeLessThan(100_000_000);
	});

	test("matches fixed-seed context and overlap variants against exhaustive pairs", () => {
		let seed = 7141;
		const next = () => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return seed;
		};
		for (let trial = 0; trial < 40; trial += 1) {
			const period = 1 + (next() % 9);
			const run = Array.from({ length: 100 + (next() % 40) }, (_, i) => i % period);
			const streams = Array.from({ length: 2 + (next() % 4) }, (_, i) =>
				syntheticStream(`${i}`, [20 + (next() % 3), ...run, 30 + (next() % 3)], 12),
			);
			const original = parity(streams);
			const reversed = parity([...streams].reverse());
			expect(canonical(reversed.raw)).toEqual(canonical(original.raw));
		}
	});

	test("keeps unequal rolling-hash collisions distinct under input permutations", () => {
		const first = new Array<number>(100).fill(200);
		const collision = [...first];
		// Adjacent polynomial terms cancel: 31 * (201 - 200) + (169 - 200) = 0.
		collision[0] = 201;
		collision[1] = 169;
		const streams = [
			syntheticStream("a", first),
			syntheticStream("b", collision),
			syntheticStream("c", first),
		];
		for (const order of [streams, [...streams].reverse(), [streams[1], streams[2], streams[0]]]) {
			const result = parity(order.filter((stream): stream is TokenStream => stream !== undefined));
			expect(result.groups).toHaveLength(1);
			expect(result.groups[0]?.members.map((member) => member.path)).toEqual(["a", "c"]);
		}
	});

	test("stops explicitly on extraction, retained-group and occurrence ceilings", () => {
		for (const options of [
			{ phaseLimits: { extraction: 0 } },
			{ maxGroups: 0 },
			{ maxOccurrences: 1 },
		]) {
			expect(() => candidate(repeatedStreams(2), options)).toThrow(DuplicationLimitError);
		}
	});
});

describe("collectTokenStream trivia (trellis-57aa)", () => {
	test("excludes JSDoc and empty syntax lists from the normalized stream", () => {
		const plain = collectTokenStream(sourceFile("a", "function x(){}\n"));
		const documented = collectTokenStream(
			sourceFile("b", "/** docs @param y value */\nfunction x(){}\n"),
		);
		expect(documented.kinds).toEqual(plain.kinds);
		expect(plain.kinds).toHaveLength(6); // function x ( ) { }
	});
});
