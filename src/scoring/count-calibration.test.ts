import { describe, expect, test } from "bun:test";
import type { MetricValue } from "../contract/index.ts";
import { normalizeCount, SCORING_FORMULA } from "./formula.ts";
import { scoreSloppiness } from "./sloppiness.ts";

/** Controlled metric profiles, not measured repositories (trellis-831b). */
function profile(counts: number[], densities: number[]): MetricValue[] {
	return SCORING_FORMULA.dimensions.flatMap((dimension, i) =>
		dimension.terms.map((term) => ({
			id: term.metricId,
			unit: "test",
			state: "complete" as const,
			value: ("countScale" in term ? counts[i] : densities[i]) ?? 0,
		})),
	);
}

describe("count calibration", () => {
	test("retains a gradient beyond every former cutoff through large repository counts", () => {
		for (const scale of [20, 15, 5]) {
			let previous = 0;
			for (const count of [1, scale, 100, 1000, 10_000, 100_000]) {
				const normalized = normalizeCount(count, scale);
				expect(normalized).toBeGreaterThan(previous);
				expect(normalized).toBeLessThan(100);
				previous = normalized;
			}
			expect(normalizeCount(0, scale)).toBe(0);
			expect(normalizeCount(-1, scale)).toBe(0);
		}
	});

	test("distinguishes controlled quality profiles at equal sizes across three orders of magnitude", () => {
		for (const kloc of [1, 10, 100]) {
			const cleaner = scoreSloppiness(profile([kloc, kloc, 0], [0.01, 0.01, 0]));
			const worse = scoreSloppiness(profile([20 * kloc, 15 * kloc, 5 * kloc], [0.3, 0.2, 0.1]));
			expect(worse.index - cleaner.index).toBeGreaterThan(40);
		}
	});

	test("rewards removing 1300 clone groups even when density remains saturated", () => {
		const before = scoreSloppiness(profile([263, 1381, 10], [0.3041, 0.2059, 0.0278]));
		const after = scoreSloppiness(profile([263, 81, 10], [0.3041, 0.2059, 0.0278]));
		expect(before.index).toBe(78);
		expect(after.index).toBe(76);
	});

	test("preserves all count contributions under arbitrarily large clean additions", () => {
		const before = scoreSloppiness(profile([263, 1381, 10], [0.3, 0.2, 0.1]));
		const after = scoreSloppiness(profile([263, 1381, 10], [0.0003, 0.0002, 0.0001]));
		const counts = (score: typeof before) =>
			score.dimensions.flatMap((dimension) =>
				dimension.terms.filter((term) => "countScale" in term).map((term) => term.normalized),
			);
		expect(counts(after)).toEqual(counts(before));
		expect(after.index).toBeGreaterThan(0);
	});
});
