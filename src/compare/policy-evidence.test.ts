import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkspaceAudit } from "../audit/run.ts";
import type { AuditReport, Finding, PolicyConfig } from "../contract/index.ts";
import { seedFixtureRepo } from "../report/audit-fixtures.ts";
import {
	evidenceReport,
	jscpdAnalysis,
	nativeComplexityAnalysis,
	preProviderReport,
} from "./fixtures.ts";
import { assessPolicy } from "./policy.ts";

/**
 * The provider-evidence policy family (SPEC §16.3, §16.5 — plan `pl-43c5`
 * step 7, trellis-68b9): requirements demand provider evidence without ever
 * changing scoring, budgets and new-finding checks route over a provider's
 * namespaced evidence, an unmet requirement fails closed even beside a clean
 * native score, and an absent optional provider with no requirement never
 * violates policy. Reports come from the shared builders (schema-validated);
 * the exit-contract tests run the real audit service over temp workspaces.
 */

/** A namespaced jscpd clone-pair finding at an arbitrary line. */
function clonePair(line: number, summary = "normalized clone pair with src/b.ts:5"): Finding {
	return {
		kind: "provider.jscpd.clone-pair",
		path: "src/a.ts",
		range: { start: { line }, end: { line: line + 14 } },
		summary,
	};
}

/** A clean native report carrying the optional analyses passed in. */
function report(...analyses: Parameters<typeof evidenceReport>[0]): AuditReport {
	return evidenceReport([nativeComplexityAnalysis(), ...analyses]);
}

function policy(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
	return { budgets: {}, failOnNew: [], requireEvidence: [], ...overrides };
}

describe("assessPolicy evidence requirements", () => {
	test("passes when the required analysis is carried complete", () => {
		const assessment = assessPolicy(
			report(jscpdAnalysis()),
			policy({ requireEvidence: ["jscpd"] }),
		);
		expect(assessment.failed).toBe(false);
		expect(assessment.results).toHaveLength(1);
		expect(assessment.results[0]).toMatchObject({
			policy: "evidence-requirement",
			subject: "jscpd",
			status: "pass",
		});
	});

	test("fails closed on every gap state with the entry's located reason", () => {
		const cases = [
			{ state: "incomplete", code: "requirement-evidence-incomplete", reason: "one file" },
			{ state: "unavailable", code: "requirement-evidence-unavailable", reason: "not installed" },
			{ state: "unsupported", code: "requirement-evidence-unsupported", reason: "not installed" },
		] as const;
		for (const { state, code, reason } of cases) {
			const assessment = assessPolicy(
				report(jscpdAnalysis({ state })),
				policy({ requireEvidence: ["jscpd"] }),
			);
			expect(assessment.failed).toBe(true);
			expect(assessment.results[0]?.status).toBe("fail");
			expect(assessment.results[0]?.reasons[0]?.code).toBe(code);
			expect(assessment.results[0]?.reasons[0]?.message).toContain(reason);
		}
	});

	test("fails closed when the required analysis is not carried and cannot be requested", () => {
		// The jscpd adapter exists but is not yet selectable through the audit
		// surface (plan pl-43c5 steps 15+) — the capability table records that.
		const assessment = assessPolicy(report(), policy({ requireEvidence: ["jscpd"] }));
		expect(assessment.failed).toBe(true);
		expect(assessment.results[0]?.reasons[0]?.code).toBe("requirement-evidence-unsupported");
		expect(assessment.results[0]?.reasons[0]?.message).toContain("not yet selectable");
	});

	test("requiring the deferred sonarjs capability is a located unsupported violation", () => {
		// Never a crash, never a silent pass: the recorded deferral decision is
		// the located reason (SPEC §16.7, docs/sonarjs-decision.md).
		const assessment = assessPolicy(report(), policy({ requireEvidence: ["sonarjs"] }));
		expect(assessment.failed).toBe(true);
		const reason = assessment.results[0]?.reasons[0];
		expect(reason?.code).toBe("requirement-evidence-unsupported");
		expect(reason?.message).toContain("docs/sonarjs-decision.md");
		expect(reason?.message).toContain("trellis-7f5d");
	});

	test("fails closed on a required id naming no supported provider analysis", () => {
		const assessment = assessPolicy(report(), policy({ requireEvidence: ["not-a-tool"] }));
		expect(assessment.failed).toBe(true);
		const reason = assessment.results[0]?.reasons[0];
		expect(reason?.code).toBe("requirement-analysis-unknown");
		expect(reason?.message).toContain("jscpd");
		expect(reason?.message).toContain("sonarjs");
	});

	test("an unmet requirement fails even beside a complete clean native score", () => {
		// The index is 10 with maxIndex 40 and every metric complete: only the
		// requirement trips, and nothing suppresses it (policies are independent).
		const assessment = assessPolicy(report(), policy({ maxIndex: 40, requireEvidence: ["jscpd"] }));
		expect(assessment.failed).toBe(true);
		const byPolicy = new Map(assessment.results.map((result) => [result.policy, result]));
		expect(byPolicy.get("max-index")?.status).toBe("pass");
		expect(byPolicy.get("evidence-requirement")?.status).toBe("fail");
	});

	test("an absent optional provider with no requirement never violates policy", () => {
		const assessment = assessPolicy(
			report(jscpdAnalysis({ state: "unavailable" })),
			policy({ maxIndex: 40 }),
		);
		expect(assessment.failed).toBe(false);
		expect(assessment.results.map((result) => result.policy)).toEqual(["max-index"]);
	});

	test("evaluates requirements in sorted order, collapsing duplicates", () => {
		const assessment = assessPolicy(
			report(),
			policy({ requireEvidence: ["sonarjs", "jscpd", "jscpd"] }),
		);
		expect(assessment.results.map((result) => result.subject)).toEqual(["jscpd", "sonarjs"]);
	});

	test("fails closed on a pre-provider report that cannot carry the analysis", () => {
		// A schema 1.0.0 report predates the evidence area: the required
		// analysis reads as not carried, never as satisfied (§16.6).
		const assessment = assessPolicy(preProviderReport(), policy({ requireEvidence: ["jscpd"] }));
		expect(assessment.failed).toBe(true);
		expect(assessment.results[0]?.reasons[0]?.code).toBe("requirement-evidence-unsupported");
	});
});

describe("assessPolicy budgets over provider evidence", () => {
	test("evaluates a budget over a complete analysis's emitted evidence metric", () => {
		const within = assessPolicy(
			report(jscpdAnalysis()),
			policy({ budgets: { "provider.jscpd.pairs": { max: 5 } } }),
		);
		expect(within.failed).toBe(false);
		expect(within.results[0]).toMatchObject({ policy: "metric-budget", status: "pass" });
		const over = assessPolicy(
			report(jscpdAnalysis()),
			policy({ budgets: { "provider.jscpd.pairs": { max: 0 } } }),
		);
		expect(over.failed).toBe(true);
		expect(over.results[0]).toMatchObject({
			policy: "metric-budget",
			subject: "provider.jscpd.pairs",
			status: "fail",
		});
		expect(over.results[0]?.reasons[0]?.code).toBe("budget-exceeded");
	});

	test("skips a budget whose optional analysis is absent — never a fabricated zero pass", () => {
		const assessment = assessPolicy(
			report(),
			policy({ budgets: { "provider.jscpd.pairs": { max: 0 } } }),
		);
		expect(assessment.failed).toBe(false);
		expect(assessment.results[0]).toMatchObject({ status: "skipped" });
		expect(assessment.results[0]?.reasons[0]?.code).toBe("budget-evidence-absent");
		expect(assessment.results[0]?.reasons[0]?.message).toContain("no zero value was fabricated");
	});

	test("fails closed when the budgeted analysis is required and its value is missing", () => {
		const assessment = assessPolicy(
			report(),
			policy({
				requireEvidence: ["jscpd"],
				budgets: { "provider.jscpd.pairs": { max: 0 } },
			}),
		);
		expect(assessment.failed).toBe(true);
		const codes = assessment.results.map((result) => result.reasons[0]?.code);
		expect(codes).toContain("requirement-evidence-unsupported");
		expect(codes).toContain("budget-evidence-missing");
	});

	test("never budgets an incomplete analysis's partial value", () => {
		// The incomplete fixture still carries its pairs metric — partial
		// evidence must not pass as a smaller measured value (§16.2).
		const skipped = assessPolicy(
			report(jscpdAnalysis({ state: "incomplete" })),
			policy({ budgets: { "provider.jscpd.pairs": { max: 0 } } }),
		);
		expect(skipped.failed).toBe(false);
		expect(skipped.results[0]?.status).toBe("skipped");
		expect(skipped.results[0]?.reasons[0]?.code).toBe("budget-evidence-absent");
		const failed = assessPolicy(
			report(jscpdAnalysis({ state: "incomplete" })),
			policy({
				requireEvidence: ["jscpd"],
				budgets: { "provider.jscpd.pairs": { max: 0 } },
			}),
		);
		expect(failed.failed).toBe(true);
		expect(failed.results.map((result) => result.reasons[0]?.code)).toContain(
			"budget-evidence-missing",
		);
	});

	test("fails a budget naming a metric the complete analysis does not emit", () => {
		const assessment = assessPolicy(
			report(jscpdAnalysis()),
			policy({ budgets: { "provider.jscpd.clone-ratio": { max: 1 } } }),
		);
		expect(assessment.failed).toBe(true);
		expect(assessment.results[0]?.reasons[0]?.code).toBe("budget-metric-unknown");
	});

	test("fails a budget naming an unknown provider's evidence", () => {
		const assessment = assessPolicy(
			report(),
			policy({ budgets: { "provider.not-a-tool.pairs": { max: 1 } } }),
		);
		expect(assessment.failed).toBe(true);
		const reason = assessment.results[0]?.reasons[0];
		expect(reason?.code).toBe("budget-metric-unknown");
		expect(reason?.message).toContain("supported:");
	});
});

describe("assessPolicy new findings over provider evidence", () => {
	test("fails on a new provider finding of a listed kind", () => {
		const baseline = report(jscpdAnalysis({ findings: [] }));
		const current = report(jscpdAnalysis({ findings: [clonePair(3)] }));
		const assessment = assessPolicy(current, policy({ failOnNew: ["provider.jscpd.clone-pair"] }), {
			baseline,
		});
		expect(assessment.failed).toBe(true);
		expect(assessment.results[0]).toMatchObject({
			policy: "new-findings",
			subject: "provider.jscpd.clone-pair",
			status: "fail",
		});
		expect(assessment.results[0]?.reasons[0]?.code).toBe("new-finding");
		expect(assessment.results[0]?.reasons[0]?.message).toContain("src/a.ts:3");
	});

	test("passes on persistent provider findings (line shifts tolerated)", () => {
		const baseline = report(jscpdAnalysis({ findings: [clonePair(3)] }));
		const current = report(jscpdAnalysis({ findings: [clonePair(12)] }));
		const assessment = assessPolicy(current, policy({ failOnNew: ["provider.jscpd.clone-pair"] }), {
			baseline,
		});
		expect(assessment.failed).toBe(false);
		expect(assessment.results[0]?.status).toBe("pass");
	});

	test("skips the check when the evidence basis is not comparable (step 6)", () => {
		const baseline = report(jscpdAnalysis({ toolVersion: "5.2.1", findings: [] }));
		const current = report(jscpdAnalysis({ toolVersion: "5.2.2", findings: [clonePair(3)] }));
		const assessment = assessPolicy(current, policy({ failOnNew: ["provider.jscpd.clone-pair"] }), {
			baseline,
		});
		expect(assessment.failed).toBe(false);
		expect(assessment.results[0]?.status).toBe("skipped");
		expect(assessment.results[0]?.reasons[0]?.code).toBe("evidence-noncomparable");
	});

	test("never treats a provider absent on the baseline as new-finding churn (§16.6)", () => {
		const baseline = report(); // no jscpd carried: unrequested there
		const current = report(jscpdAnalysis({ findings: [clonePair(3)] }));
		const assessment = assessPolicy(current, policy({ failOnNew: ["provider.jscpd.clone-pair"] }), {
			baseline,
		});
		expect(assessment.failed).toBe(false);
		expect(assessment.results[0]?.status).toBe("pass");
	});
});

describe("evidence-requirement exit contract through the audit service", () => {
	let root: string;
	let configDir: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "trellis-policy-ev-"));
		configDir = await mkdtemp(join(tmpdir(), "trellis-policy-cfg-"));
		// A clean non-Git workspace: index 0, complete — the native side of the
		// run cannot mask the provider-evidence requirement.
		await seedFixtureRepo(root, "clean");
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
		await rm(configDir, { recursive: true, force: true });
	});

	test("an unmet requirement trips policy (exit 2) while the report is still produced", async () => {
		const configPath = join(configDir, "trellis.yaml");
		await writeFile(configPath, "policy:\n  requireEvidence:\n    - jscpd\n");
		const result = await runWorkspaceAudit(root, { configPath });
		expect(result.report.score.index).toBe(0); // a complete clean native score…
		expect(result.policy.failed).toBe(true); // …that the requirement fails anyway
		const failed = result.policy.results.find((r) => r.status === "fail");
		expect(failed?.policy).toBe("evidence-requirement");
		expect(failed?.reasons[0]?.code).toBe("requirement-evidence-unsupported");
	});

	test("an invalid requirement configuration is an operational error (exit 1)", async () => {
		const configPath = join(configDir, "trellis.yaml");
		await writeFile(configPath, "policy:\n  requireEvidence:\n    - trellis.duplication\n");
		await expect(runWorkspaceAudit(root, { configPath })).rejects.toThrow(
			/policy\.requireEvidence/,
		);
	});

	test("a default audit without requirements stays clean (exit 0)", async () => {
		const configPath = join(configDir, "trellis.yaml");
		await writeFile(configPath, "policy:\n  maxIndex: 40\n");
		const result = await runWorkspaceAudit(root, { configPath });
		expect(result.policy.failed).toBe(false);
		expect(result.policy.results.map((r) => r.policy)).toEqual(["max-index"]);
	});
});
