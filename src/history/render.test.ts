import { describe, expect, test } from "bun:test";
import type { HistoryReport } from "./dashboard.ts";
import { renderHistoryMarkdown, renderHistoryTerminal } from "./render.ts";

/** A fixed history report exercising both sections and every cell shape. */
const REPORT: HistoryReport = {
	scope: { repo: null, since: null },
	audits: {
		snapshot: [
			{
				repo: "fixture#abc123def456",
				index: 14,
				partial: false,
				completeness: "complete",
				scoringVersion: "0.1.0-provisional",
				auditedAt: "2026-06-06T00:00:00.000Z",
				runs: 2,
				indexDelta: 4,
			},
			{
				repo: "partial#999888777666",
				index: 41,
				partial: true,
				completeness: "incomplete",
				scoringVersion: "0.1.0-provisional",
				auditedAt: "2026-06-05T00:00:00.000Z",
				runs: 1,
				indexDelta: null,
			},
		],
		repos: [
			{
				repo: "fixture#abc123def456",
				runs: [
					{
						auditedAt: "2026-06-01T00:00:00.000Z",
						index: 10,
						partial: false,
						completeness: "complete",
						scoringVersion: "0.1.0-provisional",
					},
					{
						auditedAt: "2026-06-06T00:00:00.000Z",
						index: 14,
						partial: false,
						completeness: "complete",
						scoringVersion: "0.1.0-provisional",
					},
				],
			},
		],
	},
	legacy: [
		{
			repo: "warren",
			runs: 3,
			latestLevel: 4,
			latestPassRate: 0.8,
			latestCoverage: 0.9,
			latestRubricVersion: "1.0.0",
			latestScoredAt: "2026-05-01T00:00:00.000Z",
		},
	],
};

/** An empty history report. */
const EMPTY: HistoryReport = {
	scope: { repo: null, since: null },
	audits: { snapshot: [], repos: [] },
	legacy: [],
};

describe("renderHistoryTerminal", () => {
	test("renders the dashboard", () => {
		expect(renderHistoryTerminal(REPORT)).toMatchSnapshot();
	});

	test("marks the direction, delta, partial state, and per-repo trend", () => {
		const out = renderHistoryTerminal(REPORT);
		expect(out).toContain("trellis report · sloppiness history");
		expect(out).toContain("lower is better");
		expect(out).toContain("14/100");
		expect(out).toContain("+4"); // worsened vs the previous compatible run
		expect(out).toContain("new"); // first run, no prior index
		expect(out).toContain("partial");
		expect(out).toContain("trend: 10 → 14");
	});

	test("labels the legacy section as a different, never-compared scale", () => {
		const out = renderHistoryTerminal(REPORT);
		expect(out).toContain("legacy readiness history");
		expect(out).toContain("never compared with the sloppiness index");
		expect(out).toContain("L4");
		expect(out).toContain("80%");
	});

	test("renders empty sections honestly", () => {
		const out = renderHistoryTerminal(EMPTY);
		expect(out).toContain("(no audit runs recorded)");
		expect(out).toContain("(no legacy runs recorded)");
	});
});

describe("renderHistoryMarkdown", () => {
	test("renders the dashboard", () => {
		expect(renderHistoryMarkdown(REPORT)).toMatchSnapshot();
	});

	test("keeps the sections distinct and carries the direction note", () => {
		const out = renderHistoryMarkdown(REPORT);
		expect(out).toContain("## Sloppiness snapshot (2)");
		expect(out).toContain("**lower is better**");
		expect(out).toContain("## `fixture#abc123def456` · 2 runs");
		expect(out).toContain("Trend: 10 → 14");
		expect(out).toContain("## Legacy readiness history");
		expect(out).toContain("never compared with, averaged into, or trended against");
	});
});
