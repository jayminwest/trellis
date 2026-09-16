import { describe, expect, test } from "bun:test";
import { SCORING_VERSION } from "../contract/index.ts";
import {
	apportionPoints,
	clamp01,
	normalizeTerm,
	roundHalfUp,
	SCORING_FORMULA,
} from "./formula.ts";

describe("SCORING_FORMULA", () => {
	test("is pinned to the contract scoring version and labelled provisional", () => {
		expect(SCORING_FORMULA.version).toBe(SCORING_VERSION);
		expect(SCORING_FORMULA.version).toBe("0.1.0-provisional");
		expect(SCORING_FORMULA.provisional).toBe(true);
	});

	test("matches the documented §7.1 constants exactly (recalibration bumps the version)", () => {
		expect(SCORING_FORMULA.dimensions).toEqual([
			{
				dimension: "complexity-erosion",
				weight: 0.5,
				terms: [
					{ metricId: "erosion.eroded-count.production", saturatesAt: 20, share: 0.5 },
					{ metricId: "erosion.eroded-share.production", saturatesAt: 0.25, share: 0.5 },
				],
			},
			{
				dimension: "duplication",
				weight: 0.3,
				terms: [
					{ metricId: "duplication.density.production", saturatesAt: 0.15, share: 0.5 },
					{ metricId: "duplication.groups.production", saturatesAt: 15, share: 0.5 },
				],
			},
			{
				dimension: "import-cycle",
				weight: 0.2,
				terms: [
					{ metricId: "import-cycle.density", saturatesAt: 0.1, share: 0.5 },
					{ metricId: "import-cycle.groups", saturatesAt: 5, share: 0.5 },
				],
			},
		]);
	});

	test("dimension weights sum to 1 and term shares sum to 1 per dimension", () => {
		const totalWeight = SCORING_FORMULA.dimensions.reduce((sum, d) => sum + d.weight, 0);
		expect(totalWeight).toBeCloseTo(1, 12);
		for (const dimension of SCORING_FORMULA.dimensions) {
			const share = dimension.terms.reduce((sum, term) => sum + term.share, 0);
			expect(share).toBeCloseTo(1, 12);
			for (const term of dimension.terms) {
				expect(term.saturatesAt).toBeGreaterThan(0);
			}
		}
	});

	test("term metric ids are unique across the formula", () => {
		const ids = SCORING_FORMULA.dimensions.flatMap((d) => d.terms.map((t) => t.metricId));
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("clamp01 / normalizeTerm", () => {
	test("clamps to the unit interval", () => {
		expect(clamp01(-0.5)).toBe(0);
		expect(clamp01(0)).toBe(0);
		expect(clamp01(0.25)).toBe(0.25);
		expect(clamp01(1)).toBe(1);
		expect(clamp01(7)).toBe(1);
	});

	test("normalizes linearly up to saturation and clamps beyond (bounds)", () => {
		expect(normalizeTerm(0, 0.25)).toBe(0);
		expect(normalizeTerm(0.125, 0.25)).toBe(50);
		expect(normalizeTerm(0.25, 0.25)).toBe(100);
		expect(normalizeTerm(0.9, 0.25)).toBe(100);
		expect(normalizeTerm(-3, 0.25)).toBe(0);
	});

	test("is non-decreasing in the raw value (lower-is-better monotonicity)", () => {
		const ladder = [0, 0.01, 0.1, 0.249, 0.25, 0.4, 10];
		const normalized = ladder.map((value) => normalizeTerm(value, 0.25));
		for (const [index, value] of normalized.entries()) {
			const previous = normalized[index - 1];
			if (previous !== undefined) expect(value).toBeGreaterThanOrEqual(previous);
		}
	});
});

describe("roundHalfUp", () => {
	test("rounds halves up — stable across runs and platforms", () => {
		expect(roundHalfUp(0)).toBe(0);
		expect(roundHalfUp(0.4)).toBe(0);
		expect(roundHalfUp(0.5)).toBe(1);
		expect(roundHalfUp(12.5)).toBe(13);
		expect(roundHalfUp(36.25)).toBe(36);
		expect(roundHalfUp(99.5)).toBe(100);
	});
});

describe("apportionPoints", () => {
	test("apportioned integers sum exactly to the rounded total", () => {
		const parts = [
			{ key: "a", exact: 18.75 },
			{ key: "b", exact: 7.5 },
			{ key: "c", exact: 15 },
		];
		const result = apportionPoints(41.25, parts);
		expect([...result.values()].reduce((sum, points) => sum + points, 0)).toBe(41);
		expect(result.get("a")).toBe(19); // largest fraction (0.75) wins the remainder
		expect(result.get("b")).toBe(7);
		expect(result.get("c")).toBe(15);
	});

	test("ties on fractional parts break by key ascending, independent of input order", () => {
		const parts = [
			{ key: "zeta", exact: 1.5 },
			{ key: "alpha", exact: 2.5 },
		];
		const forward = apportionPoints(4, parts);
		const reversed = apportionPoints(4, [...parts].reverse());
		expect(forward.get("alpha")).toBe(3);
		expect(forward.get("zeta")).toBe(1);
		expect([...reversed.entries()]).toEqual([...forward.entries()].sort());
	});

	test("a zero total apportions to all zeros", () => {
		const result = apportionPoints(0, [
			{ key: "a", exact: 0 },
			{ key: "b", exact: 0 },
		]);
		expect([...result.values()]).toEqual([0, 0]);
	});
});
