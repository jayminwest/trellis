import { describe, expect, test } from "bun:test";
import {
	type DetectorResult,
	detectorResultSchema,
	fail,
	MAX_RATIONALE,
	noDetector,
	notApplicable,
	pass,
} from "./types.ts";

describe("result helpers", () => {
	test("pass is a counted success with denominator 1", () => {
		expect(pass("biome.json present")).toEqual({
			numerator: 1,
			denominator: 1,
			rationale: "biome.json present",
		});
	});

	test("fail is a counted failure with denominator 1", () => {
		expect(fail("no lint config")).toEqual({
			numerator: 0,
			denominator: 1,
			rationale: "no lint config",
		});
	});

	test("notApplicable is null + not-applicable (excluded from coverage)", () => {
		expect(notApplicable("no database in repo")).toEqual({
			numerator: null,
			denominator: 1,
			naKind: "not-applicable",
			rationale: "no database in repo",
		});
	});

	test("noDetector is null + no-detector (drags coverage down)", () => {
		expect(noDetector("ruff not installed")).toEqual({
			numerator: null,
			denominator: 1,
			naKind: "no-detector",
			rationale: "ruff not installed",
		});
	});

	test("rationale is clamped to the ≤500-char contract", () => {
		const long = "x".repeat(MAX_RATIONALE + 50);
		const result = pass(long);
		expect(result.rationale.length).toBe(MAX_RATIONALE);
		expect(result.rationale.endsWith("…")).toBe(true);
	});
});

describe("detectorResultSchema", () => {
	const ok = (r: DetectorResult) => expect(detectorResultSchema.safeParse(r).success);

	test("accepts every helper's output", () => {
		ok(pass("a")).toBe(true);
		ok(fail("b")).toBe(true);
		ok(notApplicable("c")).toBe(true);
		ok(noDetector("d")).toBe(true);
	});

	test("rejects a non-1 denominator", () => {
		expect(
			detectorResultSchema.safeParse({ numerator: 1, denominator: 2, rationale: "x" }).success,
		).toBe(false);
	});

	test("rejects a null numerator without naKind", () => {
		expect(
			detectorResultSchema.safeParse({ numerator: null, denominator: 1, rationale: "x" }).success,
		).toBe(false);
	});

	test("rejects naKind on a non-null numerator", () => {
		expect(
			detectorResultSchema.safeParse({
				numerator: 1,
				denominator: 1,
				naKind: "no-detector",
				rationale: "x",
			}).success,
		).toBe(false);
	});

	test("rejects a numerator other than 0/1/null", () => {
		expect(
			detectorResultSchema.safeParse({ numerator: 2, denominator: 1, rationale: "x" }).success,
		).toBe(false);
	});

	test("rejects an empty rationale", () => {
		expect(
			detectorResultSchema.safeParse({ numerator: 1, denominator: 1, rationale: "" }).success,
		).toBe(false);
	});
});
