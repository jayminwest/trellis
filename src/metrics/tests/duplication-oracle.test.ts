import { describe, expect, test } from "bun:test";
import { collectTokenStream, type TokenStream } from "../duplication.ts";
import { detectClones } from "../duplication-detect.ts";
import {
	repeatedSource,
	repeatedStreams,
	sourceFile,
	syntheticStream,
} from "./duplication-fixtures.ts";
import { exhaustiveGroups, referenceDetection } from "./duplication-oracle.ts";

const RUN = Array.from({ length: 101 }, (_, i) => i + 1);
function parity(streams: TokenStream[]) {
	const reference = referenceDetection(streams);
	const previous = detectClones(streams);
	if (previous.exhaustion !== null)
		throw new Error("incomplete engine result is not a parity oracle");
	expect(previous.groups).toEqual(reference.groups);
	return reference;
}

describe("native duplication semantic oracle", () => {
	for (const length of [99, 100, 101]) {
		test(`enforces the ${length}-token boundary with exact token and line locations`, () => {
			const result = parity([
				syntheticStream("a.ts", RUN.slice(0, length)),
				syntheticStream("b.ts", RUN.slice(0, length)),
			]);
			expect(result.groups).toHaveLength(length < 100 ? 0 : 1);
			if (length >= 100) {
				expect(result.raw[0]?.members).toEqual([
					{ path: "a.ts", start: 0, end: length },
					{ path: "b.ts", start: 0, end: length },
				]);
				expect(result.groups[0]?.tokenCount).toBe(length);
				expect(result.groups[0]?.members.map((member) => member.range)).toEqual([
					{ start: { line: 1 }, end: { line: 3 } },
					{ start: { line: 1 }, end: { line: 3 } },
				]);
			}
		});
	}

	test("requires three lines per surviving member", () => {
		expect(
			parity([syntheticStream("a.ts", RUN, 2), syntheticStream("b.ts", RUN, 3)]).groups,
		).toEqual([]);
		expect(
			parity([syntheticStream("a.ts", RUN, 3), syntheticStream("b.ts", RUN, 3)]).groups,
		).toHaveLength(1);
	});

	test("separates maximal branches instead of transitively joining overlapping content", () => {
		const first = RUN.slice(0, 100);
		const second = first.map((kind) => kind + 110);
		const streams = [
			syntheticStream("a.ts", [...first, ...second], 8),
			syntheticStream("b.ts", [...first, 250], 4),
			syntheticStream("c.ts", [251, ...second], 4),
		];
		const result = parity(streams);
		expect(result.groups.map((group) => group.members.map((member) => member.path))).toEqual([
			["a.ts", "b.ts"],
			["a.ts", "c.ts"],
		]);
		expect(parity([...streams].reverse()).groups).toEqual(result.groups);
	});

	test("preserves within-file overlapping periodic and single-token runs", () => {
		for (const period of [1, 3, 11]) {
			const stream = syntheticStream(
				"a.ts",
				Array.from({ length: 211 }, (_, i) => (i % period) + 1),
				15,
			);
			const result = parity([stream]);
			expect(result.groups).toHaveLength(1);
			expect(result.groups[0]?.tokenCount).toBe(211 - period);
			expect(
				result.raw.some((group) => group.members.some((member) => member.start === period)),
			).toBe(true);
		}
	});

	test("never crosses file boundaries or treats empty files as clean duplicate members", () => {
		const split = RUN.slice(0, 100);
		expect(
			parity([
				syntheticStream("a.ts", split.slice(0, 50)),
				syntheticStream("b.ts", split.slice(50)),
				syntheticStream("c.ts", split),
				syntheticStream("empty.ts", []),
			]).groups,
		).toEqual([]);
		// Real kind values remain tokens; a future index must reserve distinct internal sentinels.
		expect(
			parity([
				syntheticStream("a.ts", new Array(100).fill(0)),
				syntheticStream("b.ts", new Array(100).fill(0)),
			]).groups,
		).toHaveLength(1);
		expect(parity([]).groups).toEqual([]);
	});

	test("freezes exact, renamed and divergence-split tokenization from the shared AST", () => {
		const original = repeatedSource("alpha");
		const renamed = original.replaceAll("alpha", "beta").replaceAll(/\bx\b/g, "value");
		const base = collectTokenStream(sourceFile("a.ts", original));
		for (const text of [original, renamed]) {
			const result = parity([base, collectTokenStream(sourceFile("b.ts", text))]);
			expect(result.groups[0]?.tokenCount).toBe(229);
			expect(result.groups[0]?.members.map((member) => member.lineCount)).toEqual([27, 27]);
		}
		const edited = renamed.replace(
			" if (value === 12) return 13;",
			" console.log(value);\n if (value === 12) return 13;",
		);
		const result = parity([base, collectTokenStream(sourceFile("b.ts", edited))]);
		expect(result.groups.length).toBeGreaterThan(0);
		expect(result.groups.every((group) => group.tokenCount < 229)).toBe(true);
	});

	for (const copies of [2, 10]) {
		test(`retains all ${copies} copies in a complete reference group`, () => {
			const result = parity(repeatedStreams(copies));
			expect(result.groups).toHaveLength(1);
			expect(result.groups[0]?.tokenCount).toBe(229);
			expect(result.groups[0]?.members).toHaveLength(copies);
		});
	}

	test("records forty-copy exhaustion without treating partial old output as truth", () => {
		const streams = repeatedStreams(40);
		expect(detectClones(streams).exhaustion).toEqual({ kind: "match-work", limit: 100_000_000 });
		expect(() => exhaustiveGroups(streams)).toThrow("oracle input exceeds 2500 tokens");
	});

	test("refuses cross-source-set inputs instead of certifying production/test mixing", () => {
		const a = syntheticStream("a.ts", RUN);
		expect(() => exhaustiveGroups([a, { ...a, path: "a.test.ts", sourceSet: "test" }])).toThrow(
			"one source set",
		);
	});
});
