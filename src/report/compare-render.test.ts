import { afterEach, describe, expect, test } from "bun:test";
import { compareReports, type ReportComparison } from "../compare/index.ts";
import type { AuditReport } from "../contract/index.ts";
import { auditFixture } from "./audit-fixtures.ts";
import { renderComparisonMarkdown, renderComparisonTerminal } from "./compare-render.ts";

/**
 * The comparison renderers (SPEC §9, §12, trellis-9a88): terminal and
 * Markdown views over real comparisons of core-produced artifacts. Both views
 * lead with comparability, carry the index delta with its direction and
 * scoring version, and bound their delta/finding lists while always printing
 * totals.
 */

interface Pair {
	baseline: AuditReport;
	current: AuditReport;
	comparison: ReportComparison;
	cleanup: () => Promise<void>;
}

/** Compare two render fixtures through the real comparator. */
async function compareFixtures(
	baselineKind: "clean" | "sloppy",
	currentKind: "clean" | "sloppy",
): Promise<Pair> {
	const baseline = await auditFixture(baselineKind);
	const current = await auditFixture(currentKind);
	return {
		baseline: baseline.report,
		current: current.report,
		comparison: compareReports(baseline.report, current.report),
		cleanup: async () => {
			await baseline.cleanup();
			await current.cleanup();
		},
	};
}

let pair: Pair | null = null;
afterEach(async () => {
	await pair?.cleanup();
	pair = null;
});

describe("renderComparisonTerminal", () => {
	test("renders comparability, the index delta with direction, and bounded deltas", async () => {
		pair = await compareFixtures("clean", "sloppy");
		const text = renderComparisonTerminal(pair.comparison, pair.baseline, pair.current);
		expect(text).toContain("trellis compare ·");
		expect(text).toContain("comparable: yes");
		expect(text).toMatch(/index: 0\/100 → \d+\/100 \(\+\d+\) · lower is better · scoring/);
		expect(text).toContain("metric deltas:");
		expect(text).toMatch(/findings: \d+ new · \d+ resolved · \d+ persistent/);
		expect(text).toContain("new:");
	});

	test("an incompatible pair leads with the refusal and shows no deltas", async () => {
		pair = await compareFixtures("clean", "sloppy");
		const tampered = {
			...pair.current,
			scoringVersion: "0.0.0-tampered",
		} as AuditReport;
		const comparison = compareReports(pair.baseline, tampered);
		const text = renderComparisonTerminal(comparison, pair.baseline, tampered);
		expect(text).toContain("comparable: NO");
		expect(text).toContain("scoring-version");
		expect(text).not.toContain("index:");
		expect(text).not.toContain("metric deltas:");
	});

	test("prints caveats for a proceeded comparison", async () => {
		pair = await compareFixtures("clean", "sloppy");
		// No configs supplied → the configuration-unverifiable caveat is explicit.
		expect(pair.comparison.compatibility.caveats.map((c) => c.code)).toContain(
			"configuration-unverifiable",
		);
		const text = renderComparisonTerminal(pair.comparison, pair.baseline, pair.current);
		expect(text).toContain("caveat (configuration-unverifiable)");
	});

	test("bounds long metric and finding lists while printing totals", async () => {
		pair = await compareFixtures("clean", "sloppy");
		const text = renderComparisonTerminal(pair.comparison, pair.baseline, pair.current, {
			metricLimit: 1,
			findingLimit: 1,
		});
		expect(text).toContain("(+");
		expect(text).toContain("more");
	});
});

describe("renderComparisonMarkdown", () => {
	test("renders the bounded markdown summary with tables", async () => {
		pair = await compareFixtures("clean", "sloppy");
		const md = renderComparisonMarkdown(pair.comparison, pair.baseline, pair.current);
		expect(md).toContain("# trellis compare —");
		expect(md).toContain("## Index");
		expect(md).toContain("| baseline | current | delta |");
		expect(md).toContain("Lower is better · scoring");
		expect(md).toContain("## Metric deltas");
		expect(md).toContain("| metric | baseline | current | delta |");
		expect(md).toContain("## Findings");
		expect(md).toContain("### New");
	});

	test("an incompatible pair renders the refusal without delta sections", async () => {
		pair = await compareFixtures("clean", "sloppy");
		const tampered = {
			...pair.current,
			scoringVersion: "0.0.0-tampered",
		} as AuditReport;
		const comparison = compareReports(pair.baseline, tampered);
		const md = renderComparisonMarkdown(comparison, pair.baseline, tampered);
		expect(md).toContain("comparable: NO");
		expect(md).not.toContain("## Index");
		expect(md).not.toContain("## Metric deltas");
	});

	test("renders empty delta sections honestly when nothing changed", async () => {
		pair = await compareFixtures("sloppy", "sloppy");
		const md = renderComparisonMarkdown(pair.comparison, pair.baseline, pair.current);
		expect(md).toContain("## Metric deltas (0 changed of");
		expect(md).not.toContain("| metric | baseline | current | delta |");
	});
});
