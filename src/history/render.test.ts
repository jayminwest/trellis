import { describe, expect, test } from "bun:test";
import type { ChangesSinceLastRun } from "../report/index.ts";
import type { HistoryReport } from "./dashboard.ts";
import { renderHistoryMarkdown, renderHistoryTerminal } from "./render.ts";

/** A §11 delta exercising every transition kind plus the rubric-attribution flag. */
function delta(overrides: Partial<ChangesSinceLastRun> = {}): ChangesSinceLastRun {
	return {
		previousScoredAt: "2026-06-01T00:00:00.000Z",
		previousCommit: "c0",
		previousRubricVersion: "0.2.0",
		previousLevel: 2,
		level: 4,
		netLevelMove: 2,
		rubricVersionChanged: false,
		attribution: "code",
		transitions: [
			{
				criterion: "ci_present",
				kind: "fail-to-pass",
				before: { status: "fail", numerator: 0, denominator: 1, naKind: null },
				after: { status: "pass", numerator: 1, denominator: 1, naKind: null },
			},
			{
				criterion: "tests_pass",
				kind: "pass-to-fail",
				before: { status: "pass", numerator: 2, denominator: 2, naKind: null },
				after: { status: "partial", numerator: 1, denominator: 2, naKind: null },
			},
			{
				criterion: "lint_clean",
				kind: "na-kind",
				before: { status: "no-detector", numerator: null, denominator: 1, naKind: "no-detector" },
				after: { status: "pass", numerator: 1, denominator: 1, naKind: null },
			},
			{
				criterion: "fresh",
				kind: "added",
				before: null,
				after: { status: "pass", numerator: 1, denominator: 1, naKind: null },
			},
		],
		...overrides,
	};
}

/** A two-run dashboard with a delta and a moved-criterion trend. */
function fullReport(): HistoryReport {
	return {
		rubricVersion: "0.2.0",
		scope: { repo: null, since: null },
		fleet: [
			{
				repo: "burrow",
				level: 3,
				passRate: 0.6,
				coverage: 0.8,
				rubricVersion: "0.2.0",
				commit: "b0",
				scoredAt: "2026-06-02T00:00:00.000Z",
				levelDelta: null,
				runs: 1,
			},
			{
				repo: "warren",
				level: 4,
				passRate: 0.75,
				coverage: 0.9,
				rubricVersion: "0.2.0",
				commit: "c1",
				scoredAt: "2026-06-02T00:00:00.000Z",
				levelDelta: 2,
				runs: 2,
			},
		],
		repos: [
			{
				repo: "warren",
				runs: [
					{
						scoredAt: "2026-06-01T00:00:00.000Z",
						commit: "c0",
						rubricVersion: "0.2.0",
						level: 2,
						passRate: 0.5,
						coverage: 0.85,
					},
					{
						scoredAt: "2026-06-02T00:00:00.000Z",
						commit: "c1",
						rubricVersion: "0.2.0",
						level: 4,
						passRate: 0.75,
						coverage: 0.9,
					},
				],
				changesSinceLastRun: delta(),
				trends: [
					{
						criterion: "tests_pass",
						points: [
							{
								scoredAt: "2026-06-01T00:00:00.000Z",
								status: "pass",
								numerator: 2,
								denominator: 2,
								naKind: null,
							},
							{
								scoredAt: "2026-06-02T00:00:00.000Z",
								status: "partial",
								numerator: 1,
								denominator: 2,
								naKind: null,
							},
						],
					},
				],
			},
		],
	};
}

describe("renderHistoryTerminal", () => {
	test("renders the full dashboard", () => {
		expect(renderHistoryTerminal(fullReport())).toMatchSnapshot();
	});

	test("renders an empty store", () => {
		const empty: HistoryReport = {
			rubricVersion: "0.2.0",
			scope: { repo: "warren", since: "2026-01-01T00:00:00.000Z" },
			fleet: [],
			repos: [],
		};
		expect(renderHistoryTerminal(empty)).toMatchSnapshot();
	});

	test("flags a possibly-rubric-driven delta in the attribution line", () => {
		const report = fullReport();
		const repo = report.repos[0];
		if (repo) {
			repo.changesSinceLastRun = delta({
				rubricVersionChanged: true,
				attribution: "possibly-rubric",
			});
		}
		expect(renderHistoryTerminal(report)).toContain("possibly rubric-driven: 0.2.0 → 0.2.0");
	});
});

describe("renderHistoryMarkdown", () => {
	test("renders the full dashboard", () => {
		expect(renderHistoryMarkdown(fullReport())).toMatchSnapshot();
	});

	test("renders an empty store", () => {
		const empty: HistoryReport = {
			rubricVersion: "0.2.0",
			scope: { repo: null, since: null },
			fleet: [],
			repos: [],
		};
		expect(renderHistoryMarkdown(empty)).toMatchSnapshot();
	});
});
