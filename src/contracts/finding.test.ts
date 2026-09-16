import { describe, expect, test } from "bun:test";
import { findingRangeSchema, findingSchema, relativePathSchema } from "./finding.ts";

const base = {
	kind: "complexity.hotspot",
	path: "src/report/build.ts",
	range: { start: { line: 41 }, end: { line: 128 } },
	summary: "CC 23, mass 214",
	facts: { cc: 23, mass: 214 },
};

describe("findingSchema", () => {
	test("round-trips a well-formed finding", () => {
		expect(findingSchema.parse(base)).toEqual(base);
	});

	test("rejects an empty kind", () => {
		expect(findingSchema.safeParse({ ...base, kind: "" }).success).toBe(false);
	});

	test("rejects an empty summary", () => {
		expect(findingSchema.safeParse({ ...base, summary: "" }).success).toBe(false);
	});

	test("rejects unknown keys", () => {
		expect(findingSchema.safeParse({ ...base, severity: "high" }).success).toBe(false);
	});
});

describe("findingRangeSchema", () => {
	test("rejects a zero line number", () => {
		const result = findingRangeSchema.safeParse({ start: { line: 0 }, end: { line: 3 } });
		expect(result.success).toBe(false);
	});

	test("rejects an end line before the start line", () => {
		const result = findingRangeSchema.safeParse({ start: { line: 128 }, end: { line: 41 } });
		expect(result.success).toBe(false);
	});

	test("rejects an end column before the start column on the same line", () => {
		const result = findingRangeSchema.safeParse({
			start: { line: 41, column: 10 },
			end: { line: 41, column: 2 },
		});
		expect(result.success).toBe(false);
	});

	test("accepts a single-line range with ordered columns", () => {
		const range = { start: { line: 41, column: 2 }, end: { line: 41, column: 10 } };
		expect(findingRangeSchema.parse(range)).toEqual(range);
	});
});

describe("relativePathSchema", () => {
	test("rejects an absolute POSIX path", () => {
		expect(relativePathSchema.safeParse("/etc/passwd").success).toBe(false);
	});

	test("rejects an absolute Windows path", () => {
		expect(relativePathSchema.safeParse("C:\\repo\\file.ts").success).toBe(false);
	});

	test("rejects a parent-escaping path", () => {
		expect(relativePathSchema.safeParse("../outside.ts").success).toBe(false);
		expect(relativePathSchema.safeParse("src/../../outside.ts").success).toBe(false);
	});

	test("accepts a nested repo-relative path", () => {
		expect(relativePathSchema.safeParse("src/report/build.ts").success).toBe(true);
	});
});
