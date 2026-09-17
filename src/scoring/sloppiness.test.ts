import { describe, expect, test } from "bun:test";
import {
	type AnalysisState,
	auditConfigSchema,
	type MetricValue,
	scoreSchema,
} from "../contract/index.ts";
import { SCORING_FORMULA } from "./formula.ts";
import { scoreSloppiness } from "./sloppiness.ts";

/** A complete metric (or any state) with minimal ceremony. */
function metric(id: string, value: number, state: AnalysisState = "complete"): MetricValue {
	return { id, unit: "test", state, ...(state === "complete" ? { value } : {}) };
}

/** An incomplete metric with the mandated reason (SPEC §3.3). */
function incomplete(id: string, value?: number): MetricValue {
	return {
		id,
		unit: "test",
		state: "incomplete",
		reason: "test-induced partial analysis",
		...(value === undefined ? {} : { value }),
	};
}

/** The six required production metrics, complete, with the given values (default 0). */
function productionMetrics(values: Partial<Record<string, number>>): MetricValue[] {
	const ids = SCORING_FORMULA.dimensions.flatMap((dimension) =>
		dimension.terms.map((term) => term.metricId),
	);
	return ids.map((id) => metric(id, values[id] ?? 0));
}

/** The §7.1 fixture: density terms are binary-exact; count terms use bounded logs. */
function goldenMetrics(): MetricValue[] {
	return productionMetrics({
		"erosion.eroded-share.production": 0.125, // → 50
		"erosion.eroded-count.production": 5, //     → 18.243447
		"duplication.density.production": 0.075, //  → 50
		"duplication.groups.production": 0, //       → 0
		"import-cycle.density": 0.05, //             → 50
		"import-cycle.groups": 5, //                 → 40.938389
	});
}

describe("scoreSloppiness — bounds, rounding, and contribution totals", () => {
	test("a clean repo scores 0 even with sloppy test code (test never offsets production)", () => {
		const result = scoreSloppiness([
			...productionMetrics({}),
			metric("erosion.eroded-share.test", 0.9),
			metric("duplication.density.test", 0.5),
		]);
		expect(result.index).toBe(0);
		expect(result.partial).toBe(false);
		expect(result.direction).toBe("lower-is-better");
		expect(result.provisional).toBe(true);
		expect(result.dimensions.map((d) => d.points)).toEqual([0, 0, 0]);
	});

	test("retains count headroom when all density terms saturate", () => {
		const result = scoreSloppiness(
			productionMetrics({
				"erosion.eroded-share.production": 0.9,
				"erosion.eroded-count.production": 50,
				"duplication.density.production": 0.5,
				"duplication.groups.production": 40,
				"import-cycle.density": 0.4,
				"import-cycle.groups": 9,
			}),
		);
		expect(result.index).toBe(77);
		expect(result.score.contributions.map((c) => c.points)).toEqual([39, 23, 15]);
	});

	test("golden fixture: index, rounding, and apportioned contributions match §7.1 arithmetic", () => {
		const result = scoreSloppiness(goldenMetrics());
		// Bounded-log counts: complexity ≈17.060862, duplication 7.5, cycles ≈9.093839.
		expect(result.index).toBe(34);
		expect(result.score.contributions).toEqual([
			{ dimension: "complexity-erosion", points: 17, metricIds: expect.any(Array) },
			{ dimension: "duplication", points: 8, metricIds: expect.any(Array) },
			{ dimension: "import-cycle", points: 9, metricIds: expect.any(Array) },
		]);
		const complexity = result.dimensions[0];
		expect(complexity?.normalized).toBeCloseTo(34.121724, 5);
		expect(complexity?.exactPoints).toBeCloseTo(17.060862, 5);
	});

	test("contribution points always sum exactly to the index", () => {
		const fixtures = [
			productionMetrics({}),
			goldenMetrics(),
			productionMetrics({ "duplication.groups.production": 1 }),
			productionMetrics({
				"erosion.eroded-share.production": 0.013,
				"import-cycle.groups": 2,
			}),
		];
		for (const fixture of fixtures) {
			const result = scoreSloppiness(fixture);
			const sum = result.score.contributions.reduce((total, c) => total + c.points, 0);
			expect(sum).toBe(result.index);
			expect(result.index).toBeGreaterThanOrEqual(0);
			expect(result.index).toBeLessThanOrEqual(100);
		}
	});

	test("the index never decreases when any single raw metric worsens (monotonicity)", () => {
		const ids = SCORING_FORMULA.dimensions.flatMap((d) => d.terms.map((t) => t.metricId));
		const ladder = [0, 0.01, 0.4, 2.5, 1000];
		for (const id of ids) {
			const indexes = ladder.map(
				(value) => scoreSloppiness(productionMetrics({ [id]: value })).index,
			);
			for (const [position, index] of indexes.entries()) {
				const previous = indexes[position - 1];
				if (previous !== undefined) expect(index).toBeGreaterThanOrEqual(previous);
			}
		}
	});

	test("input order does not affect the result (determinism)", () => {
		const metrics = goldenMetrics();
		const shuffled = [...metrics].reverse();
		expect(scoreSloppiness(shuffled)).toEqual(scoreSloppiness(metrics));
		expect(scoreSloppiness(metrics)).toEqual(scoreSloppiness(metrics));
	});

	test("duplicate metric ids are a caller error, never silently merged", () => {
		const metrics = [...goldenMetrics(), metric("import-cycle.groups", 5)];
		expect(() => scoreSloppiness(metrics)).toThrow(/duplicate metric id/);
	});
});

describe("scoreSloppiness — missing-analysis policy", () => {
	test("an incomplete required metric degrades its dimension to full weight, never zero debt", () => {
		const result = scoreSloppiness([
			...productionMetrics({}).filter((m) => m.id !== "duplication.density.production"),
			incomplete("duplication.density.production"),
		]);
		const duplication = result.dimensions.find((d) => d.dimension === "duplication");
		expect(duplication?.state).toBe("degraded");
		expect(duplication?.normalized).toBe(100);
		expect(duplication?.points).toBe(30); // full 0.3 weight
		expect(result.index).toBe(30);
		expect(result.partial).toBe(true);
		expect(result.score.partial).toBe(true);
		expect(duplication?.explanation).toMatch(/never treated as zero debt/);
	});

	test("an incomplete metric with a partial value still degrades the whole dimension", () => {
		const result = scoreSloppiness([
			...productionMetrics({}).filter((m) => m.id !== "erosion.eroded-share.production"),
			incomplete("erosion.eroded-share.production", 0.01),
		]);
		expect(result.dimensions[0]?.normalized).toBe(100);
		expect(result.index).toBe(50); // full 0.5 weight of complexity-erosion
		expect(result.partial).toBe(true);
	});

	test("absent required metrics are missing: worst case, flagged, and listed", () => {
		const result = scoreSloppiness(
			productionMetrics({}).filter((m) => !m.id.startsWith("import-cycle.")),
		);
		expect(result.missing).toEqual(["import-cycle.density", "import-cycle.groups"]);
		expect(result.index).toBe(20); // full 0.2 weight
		expect(result.partial).toBe(true);
		const cycles = result.dimensions.find((d) => d.dimension === "import-cycle");
		expect(cycles?.metricIds).toEqual([]);
		expect(scoreSchema.safeParse(result.score).success).toBe(true);
	});

	test("an incomplete test-set metric flags partial without distorting the production index", () => {
		const result = scoreSloppiness([
			...productionMetrics({}),
			incomplete("complexity.cc.p90.test"),
		]);
		expect(result.index).toBe(0);
		expect(result.partial).toBe(true);
	});

	test("a not-applicable ratio with complete zero counts is an empty scope, not missing", () => {
		const result = scoreSloppiness([
			...productionMetrics({}).filter((m) => m.id !== "duplication.density.production"),
			{ id: "duplication.density.production", unit: "ratio", state: "not-applicable" },
		]);
		const duplication = result.dimensions.find((d) => d.dimension === "duplication");
		expect(duplication?.state).toBe("scored");
		expect(duplication?.normalized).toBe(0);
		expect(result.index).toBe(0);
		expect(result.partial).toBe(false);
	});
});

describe("scoreSloppiness — counts and densities are both retained", () => {
	test("large clean additions dilute the density term but never the hotspot-count term", () => {
		const before = scoreSloppiness(
			productionMetrics({
				"erosion.eroded-share.production": 0.2,
				"erosion.eroded-count.production": 10,
			}),
		);
		const after = scoreSloppiness(
			productionMetrics({
				"erosion.eroded-share.production": 0.02, // diluted by clean mass
				"erosion.eroded-count.production": 10, // the same hotspots persist
			}),
		);
		const countTerm = (result: typeof before) =>
			result.dimensions[0]?.terms.find((t) => t.metricId === "erosion.eroded-count.production");
		expect(countTerm(before)?.normalized).toBeCloseTo(28.849176, 5);
		expect(countTerm(after)?.normalized).toBe(countTerm(before)?.normalized); // counts are not diluted
		expect(after.index).toBeLessThan(before.index); // only the density term moved
		expect(after.index).toBeGreaterThan(0); // and the count term still weighs in
		// Both the count and the density metric remain traceable on the contribution.
		expect(after.dimensions[0]?.metricIds).toEqual([
			"erosion.eroded-count.production",
			"erosion.eroded-share.production",
		]);
		expect(after.dimensions[0]?.explanation).toContain(
			"erosion.eroded-count.production bounded-log(10, scale=20)",
		);
	});
});

describe("scoreSloppiness — policy independence and traceability", () => {
	test("audit configuration cannot carry scoring weights; budgets parse without touching the formula", () => {
		expect(auditConfigSchema.safeParse({ scoring: { weights: {} } }).success).toBe(false);
		const withBudgets = auditConfigSchema.safeParse({
			policy: { budgets: { "duplication.density.production": { max: 0.05 } } },
		});
		expect(withBudgets.success).toBe(true);
		// Scoring has no configuration input at all: same metrics ⇒ same score.
		expect(scoreSloppiness(goldenMetrics()).score).toEqual(scoreSloppiness(goldenMetrics()).score);
	});

	test("the formula consumes summed repo values, never averaged per-package ratios", () => {
		const summed: MetricValue = {
			...metric("erosion.eroded-share.production", 0.05),
			numerator: 10,
			denominator: 200,
			detail: { packages: [{ erodedShare: 0.3 }, { erodedShare: 0.002 }] },
		};
		const result = scoreSloppiness([
			...productionMetrics({}).filter((m) => m.id !== summed.id),
			summed,
		]);
		const shareTerm = result.dimensions[0]?.terms.find((t) => t.metricId === summed.id);
		expect(shareTerm?.normalized).toBe(20); // 0.05/0.25×100, not the 0.151 average
	});

	test("every contribution traces to present raw metrics and explains its terms", () => {
		const metrics = goldenMetrics();
		const result = scoreSloppiness(metrics);
		const ids = new Set(metrics.map((m) => m.id));
		for (const contribution of result.score.contributions) {
			for (const id of contribution.metricIds) expect(ids.has(id)).toBe(true);
		}
		for (const dimension of result.dimensions) {
			for (const term of dimension.terms) {
				expect(dimension.explanation).toContain(term.metricId);
			}
		}
		expect(scoreSchema.safeParse(result.score).success).toBe(true);
	});
});
