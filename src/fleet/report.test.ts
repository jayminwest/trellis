import { describe, expect, test } from "bun:test";
import type { FleetReport } from "./orchestrate.ts";
import { renderFleetMarkdown, renderFleetTerminal } from "./report.ts";

/** A fixed aggregate report exercising every entry shape: improved, first-run, regressed, error. */
const REPORT: FleetReport = {
	scoredAt: "2026-06-06T00:00:00.000Z",
	rubricVersion: "1.0.0",
	canonicalVersion: "1.0.0",
	entries: [
		{
			id: "warren",
			path: "/abs/warren",
			ok: true,
			level: 4,
			passRate: 0.78,
			coverage: 0.9,
			drift: { match: 6, "allowed-delta": 1, drift: 0, missing: 0, extra: 0 },
			previousLevel: 3,
			levelDelta: 1,
		},
		{
			id: "my-swift-app",
			path: "/abs/my-swift-app",
			ok: true,
			level: 3,
			passRate: 0.55,
			coverage: 0.8,
			drift: { match: 3, "allowed-delta": 0, drift: 2, missing: 1, extra: 0 },
			previousLevel: null,
			levelDelta: null,
		},
		{
			id: "external-repo",
			path: "/abs/external-repo",
			ok: false,
			error: "path not found or not a directory",
		},
	],
	summary: { ok: 2, error: 1 },
};

describe("renderFleetTerminal", () => {
	test("renders the aggregate dashboard", () => {
		expect(renderFleetTerminal(REPORT)).toMatchSnapshot();
	});

	test("marks the level move, first run, drift counts, and error inline", () => {
		const out = renderFleetTerminal(REPORT);
		expect(out).toContain("L4");
		expect(out).toContain("+1"); // improved vs previous run
		expect(out).toContain("new"); // first run, no prior level
		expect(out).toContain("drift 2 · miss 1");
		expect(out).toContain("error: path not found or not a directory");
		expect(out).toContain("2 ok · 1 error");
	});
});

describe("renderFleetMarkdown", () => {
	test("renders a PR/issue-ready table", () => {
		expect(renderFleetMarkdown(REPORT)).toMatchSnapshot();
	});

	test("escapes pipes in the note and keeps one row per target", () => {
		const out = renderFleetMarkdown(REPORT);
		const rows = out.split("\n").filter((l) => l.startsWith("| `"));
		expect(rows).toHaveLength(3);
		expect(out).toContain("| `warren` | L4 | 78% | 90% |");
	});
});
