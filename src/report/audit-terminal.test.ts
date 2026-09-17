import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { auditFixture, FIXTURE_KINDS, type FixtureReport } from "./audit-fixtures.ts";
import { renderAuditTerminal } from "./audit-terminal.ts";

const fixtures = new Map<string, FixtureReport>();

beforeAll(async () => {
	for (const kind of FIXTURE_KINDS) {
		fixtures.set(kind, await auditFixture(kind));
	}
});

afterAll(async () => {
	await Promise.all([...fixtures.values()].map((fixture) => fixture.cleanup()));
});

/** The rendered terminal view of one fixture kind. */
function render(kind: string): string {
	const fixture = fixtures.get(kind);
	if (fixture === undefined) throw new Error(`fixture ${kind} not built`);
	return renderAuditTerminal(fixture.report);
}

/** Legacy readiness vocabulary that must never appear in the new reports (SPEC §14). */
const LEGACY_LABELS = ["Level", "pass-rate", "rubric", "maturity", "readiness", "agent progress"];

describe("renderAuditTerminal across the render fixtures", () => {
	test("renders clean, sloppy, mixed-language, incomplete and function-free repositories", () => {
		for (const kind of FIXTURE_KINDS) {
			const output = render(kind);
			expect(output).toContain(`trellis audit · fixture-${kind}`);
			expect(output).toContain("source coverage");
			expect(output).toContain("score contributions (traceable to raw metrics)");
			expect(output).toContain("metrics");
			expect(output).toContain("safeguards (configuration evidence");
		}
	});

	test("displays every score with its direction and scoring version, never a percentage", () => {
		for (const kind of FIXTURE_KINDS) {
			const fixture = fixtures.get(kind);
			if (fixture === undefined) throw new Error(`fixture ${kind} not built`);
			const output = renderAuditTerminal(fixture.report);
			const scoreLines = output.split("\n").filter((line) => line.includes("sloppiness index"));
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
		const output = renderAuditTerminal(fixture.report);
		const hotspotSection = output.slice(output.indexOf("hotspots ("));
		const hotspotLines = hotspotSection
			.split("\n")
			.filter((line) =>
				line.trimStart().match(/^(complexity\.hotspot|duplication\.clone-group|import-cycle)\s/),
			);
		expect(hotspotLines.length).toBe(4);
		for (const line of hotspotLines) {
			expect(line).toMatch(/src\/[a-z-]+\.ts:\d+(-\d+)?/);
			expect(line).not.toContain(fixture.root);
		}
		expect(hotspotSection).toContain("complexity.hotspot");
		expect(hotspotSection).toContain("duplication.clone-group");
		expect(hotspotSection).toContain("import-cycle");
		expect(hotspotSection).toContain("src/tangled.ts:1-37");
	});
});

describe("renderAuditTerminal per-fixture content", () => {
	test("renders a clean repository with a zero index and no hotspots", () => {
		const output = render("clean");
		expect(output).toContain("sloppiness index 0/100");
		expect(output).toContain("completeness: complete");
		expect(output).toContain("hotspots: none");
		expect(output).not.toContain("PARTIAL");
	});

	test("renders a sloppy repository with ranked hotspots and traceable contributions", () => {
		const output = render("sloppy");
		expect(output).toContain("sloppiness index 54/100");
		expect(output).toContain("hotspots (top 4 of 4)");
		expect(output).toContain("complexity-erosion");
		expect(output).toContain("pts · erosion.eroded-count.production");
	});

	test("renders mixed-language surface as unsupported coverage, never cleanliness", () => {
		const output = render("mixed-language");
		expect(output).toContain("unsupported  2 files · non-TS sources, not analyzed");
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
		expect(output).toContain("declaration-only  1 file");
		expect(output).toContain("n/a");
		expect(output).not.toContain("PARTIAL");
	});
});

describe("renderAuditTerminal bounding and determinism", () => {
	test("bounds the hotspot list while always printing the total", () => {
		const fixture = fixtures.get("sloppy");
		if (fixture === undefined) throw new Error("fixture sloppy not built");
		const output = renderAuditTerminal(fixture.report, { hotspotLimit: 2 });
		expect(output).toContain("hotspots (top 2 of 4)");
		const hotspotSection = output.slice(output.indexOf("hotspots ("), output.indexOf("safeguards"));
		const hotspotLines = hotspotSection
			.split("\n")
			.filter((line) =>
				line.trimStart().match(/^(complexity\.hotspot|duplication\.clone-group|import-cycle)\s/),
			);
		expect(hotspotLines.length).toBe(2);
	});

	test("renders byte-identical output for the same report", () => {
		const fixture = fixtures.get("sloppy");
		if (fixture === undefined) throw new Error("fixture sloppy not built");
		expect(renderAuditTerminal(fixture.report)).toBe(renderAuditTerminal(fixture.report));
	});
});
