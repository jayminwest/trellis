import { describe, expect, test } from "bun:test";
import type { Rubric } from "../rubric/index.ts";
import { activeChecks, assessReport, DEFAULT_MIN_LEVEL, failingGateIds } from "./assess.ts";
import type { Report } from "./types.ts";

/** A two-criterion rubric: one gate (`type_check`), one non-gate (`readme`). */
const RUBRIC: Rubric = {
	categories: [
		{ id: "code_quality", title: "Code Quality", description: "q" },
		{ id: "documentation", title: "Documentation", description: "d" },
	],
	criteria: [
		{
			id: "type_check",
			category: "code_quality",
			scope: "repo",
			level: 1,
			skippable: false,
			discoveryVia: "deterministic",
			investigation: null,
			gate: true,
			weight: 1,
		},
		{
			id: "readme",
			category: "documentation",
			scope: "repo",
			level: 1,
			skippable: false,
			discoveryVia: "deterministic",
			investigation: null,
			gate: false,
			weight: 1,
		},
	],
};

/** Build a report with the given criteria entries, level, and optional drift. */
function report(criteria: Report["criteria"], over: Partial<Report> = {}): Report {
	return {
		repo: "fixture",
		rubricVersion: "0.1.0",
		scoredAt: "2026-06-06T00:00:00.000Z",
		commit: "abc123",
		level: 4,
		passRate: 0.8,
		coverage: 1,
		apps: { ".": { description: "root" } },
		criteria,
		...over,
	};
}

const PASS = { numerator: 1, denominator: 1, rationale: "ok" } as const;
const FAIL = { numerator: 0, denominator: 1, rationale: "no" } as const;
const NA = { numerator: null, denominator: 1, rationale: "n/a", naKind: "no-detector" } as const;

describe("activeChecks", () => {
	test("default (undefined) checks gate and drift, not level", () => {
		expect(activeChecks(undefined)).toEqual({ gate: true, drift: true, level: false });
	});

	test("each named mode isolates its single dimension; none disables all", () => {
		expect(activeChecks("gate")).toEqual({ gate: true, drift: false, level: false });
		expect(activeChecks("drift")).toEqual({ gate: false, drift: true, level: false });
		expect(activeChecks("level")).toEqual({ gate: false, drift: false, level: true });
		expect(activeChecks("none")).toEqual({ gate: false, drift: false, level: false });
	});
});

describe("failingGateIds", () => {
	test("flags a measured, non-passing gate but not a passing or N/A one", () => {
		expect(failingGateIds(report({ type_check: FAIL, readme: FAIL }), RUBRIC)).toEqual([
			"type_check",
		]);
		expect(failingGateIds(report({ type_check: PASS, readme: FAIL }), RUBRIC)).toEqual([]);
		expect(failingGateIds(report({ type_check: NA, readme: FAIL }), RUBRIC)).toEqual([]);
	});

	test("a non-gate failure never appears", () => {
		expect(failingGateIds(report({ type_check: PASS, readme: FAIL }), RUBRIC)).not.toContain(
			"readme",
		);
	});
});

describe("assessReport", () => {
	test("default fails on a gate failure", () => {
		const a = assessReport(report({ type_check: FAIL, readme: PASS }), RUBRIC);
		expect(a.failed).toBe(true);
		expect(a.reasons[0]).toContain("gate criterion failed: type_check");
	});

	test("default is clean when gates pass and no drift is present", () => {
		expect(assessReport(report({ type_check: PASS, readme: FAIL }), RUBRIC).failed).toBe(false);
	});

	test("default fails on drift even when gates pass", () => {
		const drift = {
			repo: "fixture",
			canonicalVersion: "1.0.0",
			files: [],
			summary: { match: 0, "allowed-delta": 0, drift: 2, missing: 1, extra: 0 },
		};
		const a = assessReport(report({ type_check: PASS, readme: PASS }, { drift }), RUBRIC);
		expect(a.failed).toBe(true);
		expect(a.reasons[0]).toContain("canonical drift detected (3 files)");
	});

	test("mode none is always clean", () => {
		const a = assessReport(report({ type_check: FAIL, readme: FAIL }), RUBRIC, { mode: "none" });
		expect(a).toEqual({ failed: false, reasons: [] });
	});

	test("mode gate ignores drift; mode drift ignores gate", () => {
		const drift = {
			repo: "fixture",
			canonicalVersion: "1.0.0",
			files: [],
			summary: { match: 0, "allowed-delta": 0, drift: 1, missing: 0, extra: 0 },
		};
		const r = report({ type_check: FAIL, readme: PASS }, { drift });
		// gate mode: trips on the gate, says nothing about drift.
		const g = assessReport(r, RUBRIC, { mode: "gate" });
		expect(g.failed).toBe(true);
		expect(g.reasons.join(" ")).not.toContain("drift");
		// drift mode: trips on drift, says nothing about the gate.
		const d = assessReport(r, RUBRIC, { mode: "drift" });
		expect(d.failed).toBe(true);
		expect(d.reasons.join(" ")).not.toContain("gate");
	});

	test("mode level compares against the threshold (default and explicit)", () => {
		const r = report({ type_check: PASS, readme: PASS }, { level: 3 });
		// default threshold (3): level 3 is not below 3 → clean.
		expect(DEFAULT_MIN_LEVEL).toBe(3);
		expect(assessReport(r, RUBRIC, { mode: "level" }).failed).toBe(false);
		// explicit higher threshold trips.
		const a = assessReport(r, RUBRIC, { mode: "level", minLevel: 5 });
		expect(a.failed).toBe(true);
		expect(a.reasons[0]).toContain("level L3 below minimum L5");
	});
});
