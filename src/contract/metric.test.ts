import { describe, expect, test } from "bun:test";
import { type MetricValue, metricValueSchema } from "./metric.ts";

/** The SPEC §6.1 example: a complete ratio metric with its raw pair. */
const completeRatio: MetricValue = {
	id: "duplication.density",
	state: "complete",
	value: 0.031,
	unit: "ratio",
	numerator: 412,
	denominator: 13280,
	detail: { cloneGroups: 9 },
};

describe("metricValueSchema", () => {
	test("round-trips the SPEC §6.1 example", () => {
		expect(metricValueSchema.parse(completeRatio)).toEqual(completeRatio);
	});

	test("accepts an incomplete metric with a reason and a partial value", () => {
		const parsed = metricValueSchema.parse({
			id: "duplication.density",
			state: "incomplete",
			value: 0.02,
			unit: "ratio",
			reason: "corpus exceeds the declared memory budget",
		});
		expect(parsed.state).toBe("incomplete");
	});

	test("accepts unsupported and not-applicable metrics without a value", () => {
		for (const state of ["unsupported", "not-applicable"] as const) {
			const parsed = metricValueSchema.parse({ id: "complexity.cc.p90", state, unit: "count" });
			expect(parsed.state).toBe(state);
		}
	});

	test("rejects a complete metric without a value", () => {
		const result = metricValueSchema.safeParse({
			id: "complexity.cc.p90",
			state: "complete",
			unit: "count",
		});
		expect(result.success).toBe(false);
	});

	test("rejects non-finite values", () => {
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			const result = metricValueSchema.safeParse({ ...completeRatio, value });
			expect(result.success).toBe(false);
		}
	});

	test("rejects a value on unsupported or not-applicable metrics", () => {
		for (const state of ["unsupported", "not-applicable"]) {
			const result = metricValueSchema.safeParse({ ...completeRatio, state });
			expect(result.success).toBe(false);
		}
	});

	test("rejects an incomplete metric without a reason", () => {
		const result = metricValueSchema.safeParse({
			id: "duplication.density",
			state: "incomplete",
			unit: "ratio",
		});
		expect(result.success).toBe(false);
	});

	test("rejects a reason on non-incomplete metrics", () => {
		const result = metricValueSchema.safeParse({
			...completeRatio,
			reason: "no failure to report",
		});
		expect(result.success).toBe(false);
	});

	test("rejects half of a numerator/denominator pair", () => {
		expect(metricValueSchema.safeParse({ ...completeRatio, denominator: undefined }).success).toBe(
			false,
		);
		expect(metricValueSchema.safeParse({ ...completeRatio, numerator: undefined }).success).toBe(
			false,
		);
	});

	test("rejects a zero or negative denominator and a negative numerator", () => {
		expect(metricValueSchema.safeParse({ ...completeRatio, denominator: 0 }).success).toBe(false);
		expect(metricValueSchema.safeParse({ ...completeRatio, numerator: -1 }).success).toBe(false);
	});

	test("rejects malformed ids, empty units, and unknown keys", () => {
		expect(metricValueSchema.safeParse({ ...completeRatio, id: "Duplication" }).success).toBe(
			false,
		);
		expect(metricValueSchema.safeParse({ ...completeRatio, unit: "" }).success).toBe(false);
		expect(metricValueSchema.safeParse({ ...completeRatio, extra: true }).success).toBe(false);
	});
});
