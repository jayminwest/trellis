import { describe, expect, test } from "bun:test";
import { type Finding, findingSchema, rangeSchema } from "./finding.ts";

/** The SPEC §6.2 example: a located complexity hotspot. */
const hotspot: Finding = {
	kind: "complexity.hotspot",
	path: "src/report/build.ts",
	range: { start: { line: 41 }, end: { line: 128 } },
	summary: "CC 23, mass 214",
	facts: { cc: 23, mass: 214 },
};

describe("findingSchema", () => {
	test("round-trips the SPEC §6.2 example", () => {
		expect(findingSchema.parse(hotspot)).toEqual(hotspot);
	});

	test("rejects absolute, traversal, and backslash paths", () => {
		for (const path of ["/abs/build.ts", "../build.ts", "src\\build.ts"]) {
			expect(findingSchema.safeParse({ ...hotspot, path }).success).toBe(false);
		}
	});

	test("rejects malformed kinds, empty summaries, and unknown keys", () => {
		expect(findingSchema.safeParse({ ...hotspot, kind: "Complexity Hotspot" }).success).toBe(false);
		expect(findingSchema.safeParse({ ...hotspot, summary: "" }).success).toBe(false);
		expect(findingSchema.safeParse({ ...hotspot, extra: true }).success).toBe(false);
	});

	test("requires a range", () => {
		const { range: _omitted, ...withoutRange } = hotspot;
		expect(findingSchema.safeParse(withoutRange).success).toBe(false);
	});
});

describe("rangeSchema", () => {
	test("accepts multi-line and same-line ranges with columns", () => {
		expect(
			rangeSchema.safeParse({ start: { line: 1, column: 3 }, end: { line: 2, column: 1 } }).success,
		).toBe(true);
		expect(
			rangeSchema.safeParse({ start: { line: 5, column: 2 }, end: { line: 5, column: 9 } }).success,
		).toBe(true);
	});

	test("rejects an end that precedes the start", () => {
		expect(rangeSchema.safeParse({ start: { line: 128 }, end: { line: 41 } }).success).toBe(false);
		expect(
			rangeSchema.safeParse({ start: { line: 5, column: 9 }, end: { line: 5, column: 2 } }).success,
		).toBe(false);
	});

	test("rejects zero and negative positions", () => {
		expect(rangeSchema.safeParse({ start: { line: 0 }, end: { line: 1 } }).success).toBe(false);
		expect(rangeSchema.safeParse({ start: { line: 1, column: 0 }, end: { line: 1 } }).success).toBe(
			false,
		);
	});
});
