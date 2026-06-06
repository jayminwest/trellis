import { describe, expect, test } from "bun:test";
import {
	disposition,
	MAX_RATIONALE,
	perCriterionScore,
	type ScorecardEntry,
	scorecardEntrySchema,
} from "./entry.ts";

describe("disposition", () => {
	test("a non-null numerator is counted", () => {
		expect(disposition({ numerator: 1, denominator: 1, rationale: "ok" })).toBe("counted");
		expect(disposition({ numerator: 0, denominator: 1, rationale: "no" })).toBe("counted");
	});

	test("null numerator splits by naKind", () => {
		expect(
			disposition({
				numerator: null,
				denominator: 1,
				rationale: "absent",
				naKind: "not-applicable",
			}),
		).toBe("not-applicable");
		expect(
			disposition({ numerator: null, denominator: 1, rationale: "no tool", naKind: "no-detector" }),
		).toBe("no-detector");
	});
});

describe("perCriterionScore", () => {
	test("is numerator/denominator for counted entries", () => {
		expect(perCriterionScore({ numerator: 3, denominator: 4, rationale: "x" })).toBe(0.75);
		expect(perCriterionScore({ numerator: 1, denominator: 1, rationale: "x" })).toBe(1);
	});

	test("is null for N/A entries", () => {
		expect(
			perCriterionScore({ numerator: null, denominator: 2, rationale: "x", naKind: "no-detector" }),
		).toBeNull();
	});
});

describe("scorecardEntrySchema", () => {
	test("accepts a well-formed §6.2 entry", () => {
		const entry: ScorecardEntry = { numerator: 2, denominator: 3, rationale: "2 of 3 apps pass" };
		expect(scorecardEntrySchema.parse(entry)).toEqual(entry);
	});

	test("requires naKind when numerator is null", () => {
		expect(
			scorecardEntrySchema.safeParse({ numerator: null, denominator: 1, rationale: "n/a" }).success,
		).toBe(false);
	});

	test("forbids naKind when numerator is non-null", () => {
		expect(
			scorecardEntrySchema.safeParse({
				numerator: 1,
				denominator: 1,
				rationale: "ok",
				naKind: "no-detector",
			}).success,
		).toBe(false);
	});

	test("rejects a numerator greater than its denominator", () => {
		expect(
			scorecardEntrySchema.safeParse({ numerator: 3, denominator: 2, rationale: "x" }).success,
		).toBe(false);
	});

	test("caps the rationale at 500 chars", () => {
		const ok = scorecardEntrySchema.safeParse({
			numerator: 1,
			denominator: 1,
			rationale: "a".repeat(MAX_RATIONALE),
		});
		const tooLong = scorecardEntrySchema.safeParse({
			numerator: 1,
			denominator: 1,
			rationale: "a".repeat(MAX_RATIONALE + 1),
		});
		expect(ok.success).toBe(true);
		expect(tooLong.success).toBe(false);
	});

	test("rejects a zero denominator", () => {
		expect(
			scorecardEntrySchema.safeParse({ numerator: 0, denominator: 0, rationale: "x" }).success,
		).toBe(false);
	});
});
