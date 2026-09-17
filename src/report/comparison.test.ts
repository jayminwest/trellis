import { afterEach, describe, expect, test } from "bun:test";
import {
	assessPolicy,
	compareReports,
	type PolicyAssessment,
	type ReportComparison,
} from "../compare/index.ts";
import type { AuditReport } from "../contract/index.ts";
import { auditFixture, type FixtureReport } from "./audit-fixtures.ts";
import {
	renderComparisonMarkdown,
	renderComparisonTerminal,
	renderPolicyMarkdown,
	renderPolicyTerminal,
} from "./comparison.ts";

/**
 * The comparison/policy renderers (SPEC §9, §12). Comparisons come from the
 * real compare layer over core-audited fixture reports — never hand-shaped —
 * so the rendered numbers are the ones the comparator actually computed.
 */

const fixtures: FixtureReport[] = [];

async function comparison(): Promise<{
	baseline: AuditReport;
	current: AuditReport;
	result: ReportComparison;
}> {
	const baseline = await auditFixture("clean");
	const current = await auditFixture("sloppy");
	fixtures.push(baseline, current);
	return {
		baseline: baseline.report,
		current: current.report,
		result: compareReports(baseline.report, current.report),
	};
}

afterEach(async () => {
	while (fixtures.length > 0) await fixtures.pop()?.cleanup();
});

describe("renderComparisonTerminal", () => {
	test("renders compatibility, score delta, findings, and changed metrics", async () => {
		const { result } = await comparison();
		expect(result.compatibility.comparable).toBe(true);
		const text = renderComparisonTerminal(result);
		expect(text).toContain("compatibility: comparable");
		expect(text).toContain("caveats:");
		expect(text).toContain("configuration-unverifiable");
		expect(text).toMatch(/score: \d+ → \d+ \(\+\d+(\.\d+)?, lower is better\)/);
		expect(text).toMatch(/findings: \d+ new · \d+ resolved · \d+ persistent/);
		expect(text).toContain("metric deltas (");
		expect(text).toContain("complexity.cc.max.production");
	});

	test("an incompatible pair renders its issues and no deltas", async () => {
		const { baseline, current } = await comparison();
		const mismatched: AuditReport = { ...current, scoringVersion: "0.0.0" };
		const result = compareReports(baseline, mismatched);
		expect(result.compatibility.comparable).toBe(false);
		const text = renderComparisonTerminal(result);
		expect(text).toContain("NOT comparable");
		expect(text).toContain("scoring-version");
		expect(text).not.toContain("score:");
		expect(text).not.toContain("findings:");
	});

	test("a no-change comparison omits the metric-delta block", async () => {
		const { baseline } = await comparison();
		const result = compareReports(baseline, baseline);
		const text = renderComparisonTerminal(result);
		expect(text).toContain("(0, lower is better)");
		expect(text).not.toContain("metric deltas");
	});
});

describe("renderComparisonMarkdown", () => {
	test("renders the bounded markdown summary with a delta table", async () => {
		const { result } = await comparison();
		const md = renderComparisonMarkdown(result);
		expect(md).toContain("**Compatibility:** comparable");
		expect(md).toContain("**Score:**");
		expect(md).toContain("lower is better");
		expect(md).toContain("**Findings:**");
		expect(md).toContain("### Metric deltas");
		expect(md).toContain("| Metric | Baseline | Current | Δ |");
	});

	test("an incompatible pair renders issues as a markdown list", async () => {
		const { baseline, current } = await comparison();
		const result = compareReports(baseline, { ...current, analyzerVersion: "0.0.0" });
		const md = renderComparisonMarkdown(result);
		expect(md).toContain("NOT comparable");
		expect(md).toContain("`analyzer-version`");
	});
});

describe("policy renderers", () => {
	async function trippedPolicy(): Promise<PolicyAssessment> {
		const baseline = await auditFixture("clean");
		const current = await auditFixture("sloppy");
		fixtures.push(baseline, current);
		return assessPolicy(
			current.report,
			{
				maxIndex: 0,
				regression: { maxIncrease: 0 },
				budgets: { "complexity.cc.max.production": { max: 1 } },
				failOnNew: ["complexity.hotspot"],
			},
			{ baseline: baseline.report },
		);
	}

	test("renderPolicyTerminal lists each policy with status and reasons", async () => {
		const policy = await trippedPolicy();
		expect(policy.failed).toBe(true);
		const text = renderPolicyTerminal(policy);
		expect(text).toContain("policy: FAILED");
		expect(text).toContain("FAIL max-index");
		expect(text).toContain('FAIL metric-budget "complexity.cc.max.production"');
		expect(text).toContain("FAIL score-regression");
		expect(text).toContain('FAIL new-findings "complexity.hotspot"');
		expect(text).toContain("index-exceeds-max".length > 0 ? "exceeds the configured maximum" : "");
	});

	test("renderPolicyMarkdown renders a table with a verdict line", async () => {
		const policy = await trippedPolicy();
		const md = renderPolicyMarkdown(policy);
		expect(md).toContain("**Policy:** FAILED");
		expect(md).toContain("| Policy | Subject | Status | Reasons |");
		expect(md).toContain("| max-index | — | FAIL |");
		expect(md).toContain("| metric-budget | complexity.cc.max.production | FAIL |");
	});

	test("a clean policy renders pass statuses without reasons", async () => {
		const fixture = await auditFixture("clean");
		fixtures.push(fixture);
		const policy = assessPolicy(fixture.report, {
			maxIndex: 100,
			budgets: {},
			failOnNew: [],
		});
		expect(policy.failed).toBe(false);
		const text = renderPolicyTerminal(policy);
		expect(text).toContain("policy: clean");
		expect(text).toContain("pass max-index");
		expect(renderPolicyMarkdown(policy)).toContain("**Policy:** clean");
	});

	test("a skipped baseline-dependent policy renders its skip reason", async () => {
		const fixture = await auditFixture("clean");
		fixtures.push(fixture);
		const policy = assessPolicy(fixture.report, {
			regression: { maxIncrease: 1 },
			budgets: {},
			failOnNew: [],
		});
		const text = renderPolicyTerminal(policy);
		expect(text).toContain("skip score-regression");
		expect(text).toContain("no baseline report supplied");
	});
});
