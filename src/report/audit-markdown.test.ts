import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AuditReport, Finding } from "../contract/index.ts";
import { auditFixture, FIXTURE_KINDS, type FixtureReport } from "./audit-fixtures.ts";
import { renderAuditMarkdown } from "./audit-markdown.ts";

const fixtures = new Map<string, FixtureReport>();

beforeAll(async () => {
	for (const kind of FIXTURE_KINDS) {
		fixtures.set(kind, await auditFixture(kind));
	}
});

afterAll(async () => {
	await Promise.all([...fixtures.values()].map((fixture) => fixture.cleanup()));
});

/** The rendered markdown view of one fixture kind. */
function render(kind: string): string {
	const fixture = fixtures.get(kind);
	if (fixture === undefined) throw new Error(`fixture ${kind} not built`);
	return renderAuditMarkdown(fixture.report);
}

/** Legacy readiness vocabulary that must never appear in the new reports (SPEC §14). */
const LEGACY_LABELS = ["Level", "pass-rate", "rubric", "maturity", "readiness", "agent progress"];

describe("renderAuditMarkdown across the render fixtures", () => {
	test("renders clean, sloppy, mixed-language, incomplete and function-free repositories", () => {
		for (const kind of FIXTURE_KINDS) {
			const output = render(kind);
			expect(output).toContain(`# trellis audit — fixture-${kind}`);
			expect(output).toContain("## Source coverage");
			expect(output).toContain("## Score contributions");
			expect(output).toContain("## Metrics");
			expect(output).toContain("## Hotspots");
			expect(output).toContain("## Safeguards");
		}
	});

	test("displays every score with its direction and scoring version, never a percentage", () => {
		for (const kind of FIXTURE_KINDS) {
			const fixture = fixtures.get(kind);
			if (fixture === undefined) throw new Error(`fixture ${kind} not built`);
			const output = renderAuditMarkdown(fixture.report);
			const scoreLines = output.split("\n").filter((line) => /sloppiness index \d/.test(line));
			expect(scoreLines.length).toBeGreaterThan(0);
			for (const line of scoreLines) {
				expect(line).toContain(`${fixture.report.score.index}/100`);
				expect(line).toContain("lower is better");
				expect(line).toContain(`scoring ${fixture.report.scoringVersion}`);
			}
			// The index is 0–100 lower-is-better — output never implies a % of bad code (§3.4).
			expect(output).not.toMatch(/\d+%/);
		}
	});

	test("shows no readiness levels, agent progress, or legacy category labels", () => {
		for (const kind of FIXTURE_KINDS) {
			const output = render(kind);
			for (const label of LEGACY_LABELS) {
				expect(output).not.toContain(label);
			}
		}
	});

	test("points hotspots at usable relative paths with line locations", () => {
		const fixture = fixtures.get("sloppy");
		if (fixture === undefined) throw new Error("fixture sloppy not built");
		const output = renderAuditMarkdown(fixture.report);
		const hotspotRows = output
			.split("\n")
			.filter((line) =>
				line.match(/^\| (complexity\.hotspot|duplication\.clone-group|import-cycle) \| src\//),
			);
		expect(hotspotRows.length).toBe(4);
		for (const row of hotspotRows) {
			expect(row).toMatch(/src\/[a-z-]+\.ts:\d+(-\d+)?/);
			expect(row).not.toContain(fixture.root);
		}
		expect(output).toContain("| complexity.hotspot | src/tangled.ts:1-37 |");
	});
});

describe("renderAuditMarkdown per-fixture content", () => {
	test("renders a clean repository with a zero index and an empty hotspot table", () => {
		const output = render("clean");
		expect(output).toContain("sloppiness index 0/100");
		expect(output).toContain("## Hotspots (top 0 of 0)");
		expect(output).toContain("No ranked hotspots.");
	});

	test("renders a sloppy repository with ranked hotspots and traceable contributions", () => {
		const output = render("sloppy");
		expect(output).toContain("sloppiness index 54/100");
		expect(output).toContain("## Hotspots (top 4 of 4)");
		expect(output).toContain(
			"| complexity-erosion | 26 | erosion.eroded-count.production, erosion.eroded-share.production |",
		);
	});

	test("renders mixed-language surface as unsupported coverage, never cleanliness", () => {
		const output = render("mixed-language");
		expect(output).toContain("| unsupported | 2 |  | non-TS sources, not analyzed |");
		expect(output).toContain("sloppiness index 0/100");
	});

	test("renders an incomplete repository with a flagged partial headline and reasons", () => {
		const output = render("incomplete");
		expect(output).toContain("PARTIAL (missing analysis is never zero debt)");
		expect(output).toContain("completeness: incomplete");
		expect(output).toContain("incomplete — 1 production file(s) produced parse diagnostics");
	});

	test("renders a function-free repository with honest not-applicable ratios", () => {
		const output = render("function-free");
		expect(output).toContain("sloppiness index 0/100");
		expect(output).toContain("| declaration-only | 1 | 1 |  |");
		expect(output).toContain("| duplication.density.production | n/a |");
	});
});

describe("renderAuditMarkdown bounding, escaping, and determinism", () => {
	test("bounds the hotspot list while always printing the total", () => {
		const fixture = fixtures.get("sloppy");
		if (fixture === undefined) throw new Error("fixture sloppy not built");
		const output = renderAuditMarkdown(fixture.report, { hotspotLimit: 1 });
		expect(output).toContain("## Hotspots (top 1 of 4)");
	});

	test("escapes pipes and newlines so summaries cannot break the tables", () => {
		const fixture = fixtures.get("clean");
		if (fixture === undefined) throw new Error("fixture clean not built");
		const hostile: Finding = {
			kind: "graph.unresolved-import",
			path: "src/a.ts",
			range: { start: { line: 1 }, end: { line: 1 } },
			summary: 'cannot resolve "./missing.ts" | injected\nsecond line',
		};
		const report: AuditReport = { ...fixture.report, findings: [hostile] };
		const output = renderAuditMarkdown(report);
		expect(output).toContain("## Findings (1 of 1)");
		expect(output).toContain(
			'| graph.unresolved-import | src/a.ts:1 | cannot resolve "./missing.ts" \\| injected second line |',
		);
	});

	test("renders byte-identical output for the same report", () => {
		const fixture = fixtures.get("incomplete");
		if (fixture === undefined) throw new Error("fixture incomplete not built");
		expect(renderAuditMarkdown(fixture.report)).toBe(renderAuditMarkdown(fixture.report));
	});
});
