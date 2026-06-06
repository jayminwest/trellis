import { describe, expect, test } from "bun:test";
import type { ScorecardEntry } from "../scoring/index.ts";
import { changesSinceLastRun, criterionStatus } from "./changes.ts";
import type { Report } from "./types.ts";

/** A §6.3-valid report fixture; only the fields the §11 delta reads are meaningful. */
function makeReport(overrides: Partial<Report> = {}): Report {
	return {
		repo: "fixture",
		rubricVersion: "1.0.0",
		scoredAt: "2026-06-06T00:00:00.000Z",
		commit: "abc123",
		level: 3,
		passRate: 0.75,
		coverage: 0.9,
		apps: { ".": { description: "fixture" } },
		criteria: {},
		...overrides,
	};
}

/** A counted entry shorthand. */
function counted(numerator: number, denominator = 1): ScorecardEntry {
	return { numerator, denominator, rationale: "x" };
}

/** An N/A entry shorthand. */
function na(naKind: "not-applicable" | "no-detector", denominator = 1): ScorecardEntry {
	return { numerator: null, denominator, rationale: "x", naKind };
}

describe("criterionStatus", () => {
	test("folds counted entries to pass / fail / partial", () => {
		expect(criterionStatus(counted(1))).toBe("pass");
		expect(criterionStatus(counted(0))).toBe("fail");
		expect(criterionStatus(counted(2, 3))).toBe("partial");
		expect(criterionStatus(counted(3, 3))).toBe("pass");
	});

	test("folds N/A entries to their kind", () => {
		expect(criterionStatus(na("not-applicable"))).toBe("not-applicable");
		expect(criterionStatus(na("no-detector"))).toBe("no-detector");
	});
});

describe("changesSinceLastRun transitions", () => {
	test("emits pass-to-fail and fail-to-pass on boundary crossings", () => {
		const previous = makeReport({ criteria: { a: counted(1), b: counted(0) } });
		const current = makeReport({ criteria: { a: counted(0), b: counted(1) } });
		const delta = changesSinceLastRun(current, previous);
		expect(delta.transitions).toEqual([
			{
				criterion: "a",
				kind: "pass-to-fail",
				before: { status: "pass", numerator: 1, denominator: 1, naKind: null },
				after: { status: "fail", numerator: 0, denominator: 1, naKind: null },
			},
			{
				criterion: "b",
				kind: "fail-to-pass",
				before: { status: "fail", numerator: 0, denominator: 1, naKind: null },
				after: { status: "pass", numerator: 1, denominator: 1, naKind: null },
			},
		]);
	});

	test("emits na-kind for counted↔N/A and between N/A kinds", () => {
		const previous = makeReport({ criteria: { a: counted(1), b: na("not-applicable") } });
		const current = makeReport({ criteria: { a: na("no-detector"), b: na("no-detector") } });
		const delta = changesSinceLastRun(current, previous);
		expect(delta.transitions.map((t) => [t.criterion, t.kind])).toEqual([
			["a", "na-kind"],
			["b", "na-kind"],
		]);
	});

	test("emits denominator when the app count moves but the status holds", () => {
		const previous = makeReport({ criteria: { a: counted(2, 2), b: counted(1, 2) } });
		const current = makeReport({ criteria: { a: counted(3, 3), b: counted(1, 3) } });
		const delta = changesSinceLastRun(current, previous);
		expect(delta.transitions.map((t) => [t.criterion, t.kind])).toEqual([
			["a", "denominator"],
			["b", "denominator"],
		]);
	});

	test("emits score for a within-partial numerator move at the same denominator", () => {
		const previous = makeReport({ criteria: { a: counted(1, 3) } });
		const current = makeReport({ criteria: { a: counted(2, 3) } });
		const delta = changesSinceLastRun(current, previous);
		expect(delta.transitions).toEqual([
			{
				criterion: "a",
				kind: "score",
				before: { status: "partial", numerator: 1, denominator: 3, naKind: null },
				after: { status: "partial", numerator: 2, denominator: 3, naKind: null },
			},
		]);
	});

	test("emits added and removed across a changed criterion set", () => {
		const previous = makeReport({ criteria: { gone: counted(1), kept: counted(1) } });
		const current = makeReport({ criteria: { kept: counted(1), fresh: counted(0) } });
		const delta = changesSinceLastRun(current, previous);
		// current-order first (fresh), removed (gone) appended last; kept is unchanged.
		expect(delta.transitions).toEqual([
			{
				criterion: "fresh",
				kind: "added",
				before: null,
				after: { status: "fail", numerator: 0, denominator: 1, naKind: null },
			},
			{
				criterion: "gone",
				kind: "removed",
				before: { status: "pass", numerator: 1, denominator: 1, naKind: null },
				after: null,
			},
		]);
	});

	test("omits criteria whose measured state is identical", () => {
		const previous = makeReport({ criteria: { a: counted(1), b: na("not-applicable") } });
		const current = makeReport({ criteria: { a: counted(1), b: na("not-applicable") } });
		expect(changesSinceLastRun(current, previous).transitions).toEqual([]);
	});
});

describe("changesSinceLastRun attribution & level move", () => {
	test("identical rubric versions attribute the delta to code", () => {
		const previous = makeReport({ level: 2, rubricVersion: "1.0.0" });
		const current = makeReport({ level: 4, rubricVersion: "1.0.0" });
		const delta = changesSinceLastRun(current, previous);
		expect(delta.rubricVersionChanged).toBe(false);
		expect(delta.attribution).toBe("code");
		expect(delta.netLevelMove).toBe(2);
		expect(delta.previousLevel).toBe(2);
		expect(delta.level).toBe(4);
	});

	test("differing rubric versions flag the delta as possibly rubric-driven", () => {
		const previous = makeReport({ level: 4, rubricVersion: "1.0.0" });
		const current = makeReport({ level: 3, rubricVersion: "2.0.0" });
		const delta = changesSinceLastRun(current, previous);
		expect(delta.rubricVersionChanged).toBe(true);
		expect(delta.attribution).toBe("possibly-rubric");
		expect(delta.netLevelMove).toBe(-1);
		expect(delta.previousRubricVersion).toBe("1.0.0");
	});

	test("carries the prior run's identity for the report", () => {
		const previous = makeReport({ scoredAt: "2026-05-01T00:00:00.000Z", commit: "old" });
		const current = makeReport({ scoredAt: "2026-06-01T00:00:00.000Z", commit: "new" });
		const delta = changesSinceLastRun(current, previous);
		expect(delta.previousScoredAt).toBe("2026-05-01T00:00:00.000Z");
		expect(delta.previousCommit).toBe("old");
	});
});
