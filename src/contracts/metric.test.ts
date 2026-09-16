import { describe, expect, test } from "bun:test";
import { metricValueSchema } from "./metric.ts";

const base = {
	id: "duplication.density",
	state: "complete",
	value: 0.031,
	unit: "ratio",
	numerator: 412,
	denominator: 13280,
};

describe("metricValueSchema", () => {
	test("round-trips a well-formed metric value", () => {
		expect(metricValueSchema.parse(base)).toEqual(base);
	});

	test("accepts a metric without the numerator/denominator pair", () => {
		const { numerator: _n, denominator: _d, ...rest } = base;
		expect(metricValueSchema.parse(rest)).toEqual(rest);
	});

	test("rejects a NaN value", () => {
		expect(metricValueSchema.safeParse({ ...base, value: Number.NaN }).success).toBe(false);
	});

	test("rejects an infinite value", () => {
		expect(metricValueSchema.safeParse({ ...base, value: Number.POSITIVE_INFINITY }).success).toBe(
			false,
		);
	});

	test("rejects a complete state without a value", () => {
		const { value: _v, ...rest } = base;
		expect(metricValueSchema.safeParse(rest).success).toBe(false);
	});

	test("accepts an incomplete state with a reason and no value", () => {
		const result = metricValueSchema.safeParse({
			id: "duplication.density",
			state: "incomplete",
			unit: "ratio",
			reason: "corpus exceeds the declared memory budget",
		});
		expect(result.success).toBe(true);
	});

	test("rejects an incomplete state without a reason", () => {
		const result = metricValueSchema.safeParse({
			id: "duplication.density",
			state: "incomplete",
			unit: "ratio",
		});
		expect(result.success).toBe(false);
	});

	test("rejects a numerator without its denominator", () => {
		const { denominator: _d, ...rest } = base;
		expect(metricValueSchema.safeParse(rest).success).toBe(false);
	});

	test("rejects a numerator larger than its denominator", () => {
		expect(
			metricValueSchema.safeParse({ ...base, numerator: 13281, denominator: 13280 }).success,
		).toBe(false);
	});

	test("rejects a non-integer numerator", () => {
		expect(metricValueSchema.safeParse({ ...base, numerator: 4.5 }).success).toBe(false);
	});

	test("rejects an unknown analysis state", () => {
		expect(metricValueSchema.safeParse({ ...base, state: "partial" }).success).toBe(false);
	});

	test("rejects unknown keys", () => {
		expect(metricValueSchema.safeParse({ ...base, weight: 2 }).success).toBe(false);
	});
});
