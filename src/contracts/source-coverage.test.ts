import { describe, expect, test } from "bun:test";
import { SOURCE_SETS, sourceCoverageSchema, sourceSetSchema } from "./source-coverage.ts";

describe("sourceCoverageSchema", () => {
	test("round-trips the SPEC §6.4 example shape", () => {
		const coverage = {
			production: { files: 210, sloc: 13280 },
			test: { files: 96, sloc: 5100 },
			generated: { files: 4 },
			unsupported: { files: 30, note: "non-TS sources, not analyzed" },
		};
		expect(sourceCoverageSchema.parse(coverage)).toEqual(coverage);
	});

	test("requires the production and test sets", () => {
		expect(sourceCoverageSchema.safeParse({ production: { files: 1 } }).success).toBe(false);
		expect(sourceCoverageSchema.safeParse({ test: { files: 1 } }).success).toBe(false);
	});

	test("rejects a negative file count", () => {
		const result = sourceCoverageSchema.safeParse({
			production: { files: -1 },
			test: { files: 0 },
		});
		expect(result.success).toBe(false);
	});

	test("rejects unknown keys", () => {
		const result = sourceCoverageSchema.safeParse({
			production: { files: 1 },
			test: { files: 1 },
			docs: { files: 3 },
		});
		expect(result.success).toBe(false);
	});
});

describe("sourceSetSchema", () => {
	test("accepts every documented source set", () => {
		for (const set of SOURCE_SETS) {
			expect(sourceSetSchema.safeParse(set).success).toBe(true);
		}
	});

	test("rejects an undocumented source set", () => {
		expect(sourceSetSchema.safeParse("fixtures").success).toBe(false);
	});
});
