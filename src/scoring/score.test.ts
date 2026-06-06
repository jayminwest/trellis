import { describe, expect, test } from "bun:test";
import { aggregateAppScope, aggregateRepoScope } from "./aggregate.ts";
import type { ScorecardEntry } from "./entry.ts";
import { scoreRun } from "./score.ts";

/** Build an id→entry map from positional entries (ids `c0`, `c1`, …). */
function scorecard(entries: ScorecardEntry[]): {
	ids: string[];
	map: Map<string, ScorecardEntry>;
} {
	const map = new Map<string, ScorecardEntry>();
	const ids = entries.map((entry, i) => {
		const id = `c${i}`;
		map.set(id, entry);
		return id;
	});
	return { ids, map };
}

const pass: ScorecardEntry = { numerator: 1, denominator: 1, rationale: "pass" };
const fail: ScorecardEntry = { numerator: 0, denominator: 1, rationale: "fail" };
const noDetector: ScorecardEntry = {
	numerator: null,
	denominator: 1,
	rationale: "no detector",
	naKind: "no-detector",
};
const notApplicable: ScorecardEntry = {
	numerator: null,
	denominator: 1,
	rationale: "n/a",
	naKind: "not-applicable",
};

describe("scoreRun — pass rate", () => {
	test("is the mean of per-criterion scores over counted criteria", () => {
		// 3 pass + 1 fail at full coverage → passRate 0.75 → L4, clamp no-op.
		const { ids, map } = scorecard([pass, pass, pass, fail]);
		const result = scoreRun(ids, map);
		expect(result.passRate).toBe(0.75);
		expect(result.passRateLevel).toBe(4);
		expect(result.coverage).toBe(1);
		expect(result.coverageLevel).toBe(5);
		expect(result.level).toBe(4);
	});

	test("excludes N/A entries from the pass-rate mean", () => {
		// not-applicable is excluded entirely: mean over the 2 counted = 0.5.
		const { ids, map } = scorecard([pass, fail, notApplicable]);
		const result = scoreRun(ids, map);
		expect(result.passRate).toBe(0.5);
		expect(result.counts.counted).toBe(2);
		expect(result.counts.notApplicable).toBe(1);
	});

	test("averages fractional app-scope scores alongside repo-scope", () => {
		const app = aggregateAppScope([
			{ app: "a", outcome: "pass" },
			{ app: "b", outcome: "fail" },
		]); // 1/2 = 0.5
		const { ids, map } = scorecard([pass, app]); // mean(1, 0.5) = 0.75
		expect(scoreRun(ids, map).passRate).toBe(0.75);
	});
});

describe("scoreRun — band boundaries via pass rate", () => {
	// At full coverage the level equals the pass-rate band, so we can probe every
	// 20-pt boundary by choosing numerator/denominator counts.
	const cases: Array<{ pass: number; total: number; rate: number; level: 1 | 2 | 3 | 4 | 5 }> = [
		{ pass: 0, total: 5, rate: 0, level: 1 },
		{ pass: 1, total: 5, rate: 0.2, level: 2 },
		{ pass: 2, total: 5, rate: 0.4, level: 3 },
		{ pass: 3, total: 5, rate: 0.6, level: 4 },
		{ pass: 4, total: 5, rate: 0.8, level: 5 },
		{ pass: 5, total: 5, rate: 1, level: 5 },
	];
	for (const c of cases) {
		test(`${c.pass}/${c.total} → passRate ${c.rate} → L${c.level}`, () => {
			const entries = Array.from({ length: c.total }, (_, i) => (i < c.pass ? pass : fail));
			const { ids, map } = scorecard(entries);
			const result = scoreRun(ids, map);
			expect(result.passRate).toBeCloseTo(c.rate, 10);
			expect(result.level).toBe(c.level);
		});
	}
});

describe("scoreRun — coverage clamp", () => {
	test("is a no-op at full coverage (all criteria counted)", () => {
		const { ids, map } = scorecard([pass, pass, pass, pass, fail]); // 0.8 → L5
		const result = scoreRun(ids, map);
		expect(result.coverage).toBe(1);
		expect(result.coverageLevel).toBe(5);
		expect(result.level).toBe(result.passRateLevel);
		expect(result.level).toBe(5);
	});

	test("lowers the level when coverage is thin (no-detector base)", () => {
		// 1 counted pass (passRate 1 → L5) but 4 no-detector → coverage 1/5 = 0.2 → L2.
		const { ids, map } = scorecard([pass, noDetector, noDetector, noDetector, noDetector]);
		const result = scoreRun(ids, map);
		expect(result.passRateLevel).toBe(5);
		expect(result.coverage).toBeCloseTo(0.2, 10);
		expect(result.coverageLevel).toBe(2);
		expect(result.level).toBe(2); // clamped down
	});

	test("counts skipped (no scorecard entry) against coverage", () => {
		// Universe of 4 ids, only 1 has an entry → 3 skipped → coverage 1/4 = 0.25 → L2.
		const { map } = scorecard([pass]);
		const ids = ["c0", "missing1", "missing2", "missing3"];
		const result = scoreRun(ids, map);
		expect(result.counts.skipped).toBe(3);
		expect(result.coverage).toBe(0.25);
		expect(result.coverageLevel).toBe(2);
		expect(result.level).toBe(2);
	});

	test("not-applicable is excluded from the coverage base (no clamp penalty)", () => {
		// 1 pass + 3 not-applicable → coverage base is just the 1 counted → 1.0.
		const { ids, map } = scorecard([pass, notApplicable, notApplicable, notApplicable]);
		const result = scoreRun(ids, map);
		expect(result.coverage).toBe(1);
		expect(result.coverageLevel).toBe(5);
		expect(result.level).toBe(5);
	});
});

describe("scoreRun — counts & edges", () => {
	test("counts partition the universe and sum to total", () => {
		const { map } = scorecard([pass, fail, noDetector, notApplicable]);
		const ids = ["c0", "c1", "c2", "c3", "skipped"];
		const { counts } = scoreRun(ids, map);
		expect(counts).toEqual({
			total: 5,
			counted: 2,
			noDetector: 1,
			notApplicable: 1,
			skipped: 1,
		});
		expect(counts.counted + counts.noDetector + counts.notApplicable + counts.skipped).toBe(
			counts.total,
		);
	});

	test("ignores entries for ids outside the rubric universe", () => {
		const { map } = scorecard([pass, fail]);
		const result = scoreRun(["c0"], map); // c1 not in the universe
		expect(result.counts.total).toBe(1);
		expect(result.counts.counted).toBe(1);
		expect(result.passRate).toBe(1);
	});

	test("an empty universe scores L1 with zeroed rates", () => {
		const result = scoreRun([], new Map());
		expect(result.passRate).toBe(0);
		expect(result.coverage).toBe(0);
		expect(result.level).toBe(1);
	});

	test("an all-not-applicable run scores L1 (nothing measured)", () => {
		const { ids, map } = scorecard([notApplicable, notApplicable]);
		const result = scoreRun(ids, map);
		expect(result.counts.counted).toBe(0);
		expect(result.passRate).toBe(0);
		expect(result.coverage).toBe(0);
		expect(result.level).toBe(1);
	});
});

describe("scoreRun — repo/app aggregation end to end", () => {
	test("scores a mixed repo/app scorecard through the aggregators", () => {
		const entries = [
			aggregateRepoScope({ outcome: "pass", rationale: "lint configured" }),
			aggregateRepoScope({ outcome: "fail", rationale: "no coverage ratchet" }),
			aggregateAppScope([
				{ app: "src/ui", outcome: "pass" },
				{ app: ".", outcome: "pass" },
			]), // 2/2 = 1
			aggregateAppScope([
				{ app: "src/ui", outcome: "not-applicable" },
				{ app: ".", outcome: "not-applicable" },
			]), // excluded
		];
		const { ids, map } = scorecard(entries);
		const result = scoreRun(ids, map);
		// counted: repo-pass(1) + repo-fail(0) + app(1) → mean = 2/3.
		expect(result.passRate).toBeCloseTo(2 / 3, 10);
		expect(result.counts.counted).toBe(3);
		expect(result.counts.notApplicable).toBe(1);
		expect(result.coverage).toBe(1); // not-applicable excluded → full coverage
	});
});
