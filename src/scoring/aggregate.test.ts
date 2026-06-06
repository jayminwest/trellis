import { describe, expect, test } from "bun:test";
import { type AppResult, aggregateAppScope, aggregateRepoScope } from "./aggregate.ts";
import { MAX_RATIONALE, scorecardEntrySchema } from "./entry.ts";

describe("aggregateRepoScope", () => {
	test("pass → 1/1, fail → 0/1, with denominator always 1", () => {
		expect(aggregateRepoScope({ outcome: "pass", rationale: "ok" })).toEqual({
			numerator: 1,
			denominator: 1,
			rationale: "ok",
		});
		expect(aggregateRepoScope({ outcome: "fail", rationale: "missing" })).toEqual({
			numerator: 0,
			denominator: 1,
			rationale: "missing",
		});
	});

	test("N/A outcomes carry the matching naKind with a null numerator", () => {
		expect(aggregateRepoScope({ outcome: "not-applicable", rationale: "no db" })).toEqual({
			numerator: null,
			denominator: 1,
			rationale: "no db",
			naKind: "not-applicable",
		});
		expect(aggregateRepoScope({ outcome: "no-detector", rationale: "no adapter" })).toEqual({
			numerator: null,
			denominator: 1,
			rationale: "no adapter",
			naKind: "no-detector",
		});
	});

	test("produces a §6.2-valid entry", () => {
		expect(
			scorecardEntrySchema.safeParse(aggregateRepoScope({ outcome: "pass", rationale: "ok" }))
				.success,
		).toBe(true);
	});
});

describe("aggregateAppScope", () => {
	test("rolls N apps into passing/N", () => {
		const apps: AppResult[] = [
			{ app: "src/ui", outcome: "pass" },
			{ app: ".", outcome: "fail" },
			{ app: "svc", outcome: "pass" },
		];
		const entry = aggregateAppScope(apps);
		expect(entry.numerator).toBe(2);
		expect(entry.denominator).toBe(3);
		expect(entry.naKind).toBeUndefined();
	});

	test("counts N/A apps in the denominator but not the numerator", () => {
		const entry = aggregateAppScope([
			{ app: "a", outcome: "pass" },
			{ app: "b", outcome: "not-applicable" },
		]);
		expect(entry.numerator).toBe(1);
		expect(entry.denominator).toBe(2);
	});

	test("all-N/A apps collapse to not-applicable", () => {
		const entry = aggregateAppScope([
			{ app: "a", outcome: "not-applicable" },
			{ app: "b", outcome: "not-applicable" },
		]);
		expect(entry.numerator).toBeNull();
		expect(entry.denominator).toBe(2);
		expect(entry.naKind).toBe("not-applicable");
	});

	test("all-N/A with any no-detector collapses to no-detector", () => {
		const entry = aggregateAppScope([
			{ app: "a", outcome: "not-applicable" },
			{ app: "b", outcome: "no-detector" },
		]);
		expect(entry.naKind).toBe("no-detector");
		expect(entry.numerator).toBeNull();
	});

	test("throws when given zero apps", () => {
		expect(() => aggregateAppScope([])).toThrow();
	});

	test("clips a synthesized rationale to 500 chars", () => {
		const apps: AppResult[] = Array.from({ length: 60 }, (_, i) => ({
			app: `application-directory-number-${i}`,
			outcome: "pass" as const,
		}));
		const entry = aggregateAppScope(apps);
		expect(entry.rationale.length).toBeLessThanOrEqual(MAX_RATIONALE);
		expect(scorecardEntrySchema.safeParse(entry).success).toBe(true);
	});
});
