import { describe, expect, test } from "bun:test";
import type { AuditReport, Finding, MetricValue, PolicyConfig } from "../contract/index.ts";
import { assessPolicy } from "./policy.ts";

function finding(kind: string, path: string, line: number): Finding {
	return {
		kind,
		path,
		range: { start: { line }, end: { line: line + 9 } },
		summary: `${kind} at ${path}:${line}`,
	};
}

/** A minimal but fully valid §6.4 report; tests mutate the fields they exercise. */
function baseReport(index = 20): AuditReport {
	const density: MetricValue = {
		id: "duplication.density",
		state: "complete",
		value: 0.03,
		unit: "ratio",
	};
	return {
		schemaVersion: "1.0.0",
		analyzerVersion: "0.2.0",
		scoringVersion: "0.1.0-provisional",
		repo: { root: "/abs/path" },
		sourceCoverage: { production: { files: 10, sloc: 500 }, test: { files: 4, sloc: 120 } },
		completeness: "complete",
		metrics: { "duplication.density": density },
		score: {
			index,
			direction: "lower-is-better",
			partial: false,
			contributions: [
				{ dimension: "duplication", points: index, metricIds: ["duplication.density"] },
			],
		},
		findings: [],
		safeguards: [],
	};
}

function policy(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
	return { budgets: {}, failOnNew: [], requireEvidence: [], ...overrides };
}

describe("assessPolicy max-index", () => {
	test("passes at or below the configured maximum and fails above it", () => {
		const atLimit = assessPolicy(baseReport(40), policy({ maxIndex: 40 }));
		expect(atLimit.failed).toBe(false);
		expect(atLimit.results[0]).toMatchObject({ policy: "max-index", status: "pass" });
		const over = assessPolicy(baseReport(41), policy({ maxIndex: 40 }));
		expect(over.failed).toBe(true);
		expect(over.results[0]?.status).toBe("fail");
		expect(over.results[0]?.reasons[0]?.code).toBe("index-exceeds-max");
	});

	test("evaluates nothing when no policy is configured", () => {
		const assessment = assessPolicy(baseReport(99), policy());
		expect(assessment.failed).toBe(false);
		expect(assessment.results).toEqual([]);
	});
});

describe("assessPolicy metric budgets", () => {
	test("fails a budget whose metric exceeds the max, passes one within it", () => {
		const assessment = assessPolicy(
			baseReport(),
			policy({ budgets: { "duplication.density": { max: 0.05 } } }),
		);
		expect(assessment.failed).toBe(false);
		const failing = assessPolicy(
			baseReport(),
			policy({ budgets: { "duplication.density": { max: 0.02 } } }),
		);
		expect(failing.failed).toBe(true);
		expect(failing.results[0]).toMatchObject({
			policy: "metric-budget",
			subject: "duplication.density",
			status: "fail",
		});
		expect(failing.results[0]?.reasons[0]?.code).toBe("budget-exceeded");
	});

	test("fails closed on a budget naming a metric absent from the report", () => {
		const assessment = assessPolicy(
			baseReport(),
			policy({ budgets: { "erosion.eroded-share.production": { max: 0.1 } } }),
		);
		expect(assessment.failed).toBe(true);
		expect(assessment.results[0]?.reasons[0]?.code).toBe("budget-metric-unknown");
	});

	test("skips a budget over an incomplete metric without failing", () => {
		const report = baseReport();
		report.completeness = "incomplete";
		report.score.partial = true;
		report.metrics["duplication.density"] = {
			id: "duplication.density",
			state: "incomplete",
			unit: "ratio",
			reason: "token budget exhausted",
		};
		const assessment = assessPolicy(
			report,
			policy({ budgets: { "duplication.density": { max: 0.02 } } }),
		);
		expect(assessment.failed).toBe(false);
		expect(assessment.results[0]?.status).toBe("skipped");
		expect(assessment.results[0]?.reasons[0]?.code).toBe("budget-metric-unevaluable");
	});
});

describe("assessPolicy score regression", () => {
	test("skips without a baseline and never fails a first run", () => {
		const assessment = assessPolicy(baseReport(90), policy({ regression: { maxIncrease: 0 } }));
		expect(assessment.failed).toBe(false);
		expect(assessment.results[0]?.status).toBe("skipped");
		expect(assessment.results[0]?.reasons[0]?.code).toBe("baseline-absent");
	});

	test("applies the absolute tolerance in index points, not zero", () => {
		const baseline = baseReport(20);
		const within = assessPolicy(baseReport(22), policy({ regression: { maxIncrease: 2 } }), {
			baseline,
		});
		expect(within.failed).toBe(false);
		const over = assessPolicy(baseReport(23), policy({ regression: { maxIncrease: 2 } }), {
			baseline,
		});
		expect(over.failed).toBe(true);
		expect(over.results[0]?.reasons[0]?.code).toBe("regression-exceeds-absolute");
	});

	test("applies the relative tolerance as a percentage of the baseline index", () => {
		const baseline = baseReport(20);
		const within = assessPolicy(
			baseReport(22),
			policy({ regression: { maxIncreasePercent: 10 } }),
			{ baseline },
		);
		expect(within.failed).toBe(false);
		const over = assessPolicy(baseReport(23), policy({ regression: { maxIncreasePercent: 10 } }), {
			baseline,
		});
		expect(over.failed).toBe(true);
		expect(over.results[0]?.reasons[0]?.code).toBe("regression-exceeds-relative");
	});

	test("fails when either configured bound is exceeded", () => {
		const baseline = baseReport(20);
		// Absolute bound satisfied (1 ≤ 2) but relative bound tripped (1 > 20×4%).
		const assessment = assessPolicy(
			baseReport(21),
			policy({ regression: { maxIncrease: 2, maxIncreasePercent: 4 } }),
			{ baseline },
		);
		expect(assessment.failed).toBe(true);
		expect(assessment.results[0]?.reasons.map((r) => r.code)).toEqual([
			"regression-exceeds-relative",
		]);
	});

	test("tolerates zero increase when the regression block carries no knobs", () => {
		const assessment = assessPolicy(baseReport(21), policy({ regression: {} }), {
			baseline: baseReport(20),
		});
		expect(assessment.failed).toBe(true);
		expect(assessment.results[0]?.reasons[0]?.code).toBe("regression-exceeds-absolute");
	});

	test("never treats an equal or better index as a regression", () => {
		for (const index of [20, 5]) {
			const assessment = assessPolicy(baseReport(index), policy({ regression: {} }), {
				baseline: baseReport(20),
			});
			expect(assessment.failed).toBe(false);
			expect(assessment.results[0]?.status).toBe("pass");
		}
	});

	test("fails closed on an incompatible baseline instead of silently passing", () => {
		const baseline = { ...baseReport(20), analyzerVersion: "9.9.9" };
		const assessment = assessPolicy(baseReport(20), policy({ regression: { maxIncrease: 5 } }), {
			baseline,
		});
		expect(assessment.failed).toBe(true);
		expect(assessment.results[0]?.status).toBe("fail");
		expect(assessment.results[0]?.reasons[0]?.code).toBe("baseline-incompatible");
	});
});

describe("assessPolicy new findings", () => {
	test("fails on a new finding of a listed kind and passes on persistent ones", () => {
		const baseline = baseReport();
		baseline.findings = [finding("complexity.hotspot", "src/a.ts", 10)];
		const current = baseReport();
		current.findings = [
			finding("complexity.hotspot", "src/a.ts", 14), // line shift: persistent
			finding("import-cycle", "src/cyc-a.ts", 1), // new
		];
		const assessment = assessPolicy(current, policy({ failOnNew: ["import-cycle"] }), {
			baseline,
		});
		expect(assessment.failed).toBe(true);
		expect(assessment.results[0]).toMatchObject({
			policy: "new-findings",
			subject: "import-cycle",
			status: "fail",
		});
		expect(assessment.results[0]?.reasons[0]?.code).toBe("new-finding");
		expect(assessment.results[0]?.reasons[0]?.message).toContain("src/cyc-a.ts:1");
	});

	test("passes when new findings are not of a listed kind", () => {
		const current = baseReport();
		current.findings = [finding("duplication.clone-group", "src/dup.ts", 1)];
		const assessment = assessPolicy(current, policy({ failOnNew: ["import-cycle"] }), {
			baseline: baseReport(),
		});
		expect(assessment.failed).toBe(false);
		expect(assessment.results[0]?.status).toBe("pass");
	});

	test("bounds the locations listed in one reason message", () => {
		const current = baseReport();
		current.findings = Array.from({ length: 8 }, (_, i) =>
			finding("import-cycle", `src/cyc-${i}.ts`, 1),
		);
		const assessment = assessPolicy(current, policy({ failOnNew: ["import-cycle"] }), {
			baseline: baseReport(),
		});
		const message = assessment.results[0]?.reasons[0]?.message ?? "";
		expect(message).toContain("8 new");
		expect(message).toContain("(+3 more)");
	});

	test("a better aggregate index cannot suppress a configured new-cycle failure", () => {
		const baseline = baseReport(40);
		const current = baseReport(10); // dramatically better, and under maxIndex
		current.findings = [finding("import-cycle", "src/cyc-a.ts", 1)];
		const assessment = assessPolicy(
			current,
			policy({
				maxIndex: 40,
				regression: { maxIncrease: 0 },
				failOnNew: ["import-cycle", "complexity.hotspot"],
			}),
			{ baseline },
		);
		expect(assessment.failed).toBe(true);
		const byPolicy = new Map(assessment.results.map((r) => [r.subject ?? r.policy, r]));
		expect(byPolicy.get("max-index")?.status).toBe("pass");
		expect(byPolicy.get("score-regression")?.status).toBe("pass");
		expect(byPolicy.get("import-cycle")?.status).toBe("fail");
		expect(byPolicy.get("complexity.hotspot")?.status).toBe("pass");
	});

	test("reports baseline-absent and baseline-incompatible per failOnNew kind", () => {
		const absent = assessPolicy(baseReport(), policy({ failOnNew: ["import-cycle"] }));
		expect(absent.failed).toBe(false);
		expect(absent.results[0]).toMatchObject({
			policy: "new-findings",
			subject: "import-cycle",
			status: "skipped",
		});
		const incompatible = assessPolicy(baseReport(), policy({ failOnNew: ["import-cycle"] }), {
			baseline: { ...baseReport(), scoringVersion: "9.9.9" },
		});
		expect(incompatible.failed).toBe(true);
		expect(incompatible.results[0]?.reasons[0]?.code).toBe("baseline-incompatible");
	});
});
