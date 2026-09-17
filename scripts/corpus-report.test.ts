import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditWorkspace } from "../src/audit/audit.ts";
import {
	assessPair,
	type CorpusRecordView,
	type EntrySummary,
	evaluateChecks,
	formatMarkdown,
	summarizeReport,
} from "./corpus-report.ts";
import type { CorpusPair } from "./validate-corpus.ts";

/** A minimal summary with the given metric values; unlisted metrics are absent. */
function summary(id: string, index: number, metrics: Record<string, number>): EntrySummary {
	const snapshots: EntrySummary["metrics"] = {};
	for (const [metricId, value] of Object.entries(metrics)) {
		snapshots[metricId] = { state: "complete", value };
	}
	return {
		id,
		index,
		partial: false,
		completeness: "complete",
		productionFiles: 1,
		productionSloc: 10,
		testFiles: 0,
		testSloc: 0,
		metrics: snapshots,
	};
}

function pair(overrides: Partial<CorpusPair>): CorpusPair {
	return {
		id: "p",
		before: "a",
		after: "b",
		expectDecrease: [],
		expectIncrease: [],
		expectUnchanged: [],
		...overrides,
	};
}

describe("summarizeReport", () => {
	test("projects a real audit report to its corpus summary", async () => {
		const repo = await mkdtemp(join(tmpdir(), "trellis-corpus-summary-"));
		try {
			await mkdir(join(repo, "src"), { recursive: true });
			await writeFile(join(repo, "package.json"), JSON.stringify({ name: "summary-fixture" }));
			await writeFile(join(repo, "src/a.ts"), "export const a = 1;\n");
			const report = await auditWorkspace(repo);
			const projected = summarizeReport("x", report);
			expect(projected.id).toBe("x");
			expect(projected.index).toBe(report.score.index);
			expect(projected.completeness).toBe("complete");
			expect(projected.productionFiles).toBe(1);
			expect(projected.metrics["import-cycle.groups"]).toEqual({ state: "complete", value: 0 });
			expect(projected.metrics["duplication.density.test"]?.state).toBe("not-applicable");
			expect(projected.metrics["duplication.density.test"]?.value).toBeNull();
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});
});

describe("evaluateChecks", () => {
	const base = summary("s", 7, { "duplication.groups.production": 3 });

	test("passes and fails scalar operators against the actual value", () => {
		const results = evaluateChecks(base, {
			index: { eq: 7 },
			"duplication.groups.production": { gt: 2 },
			partial: { eq: false },
			completeness: { eq: "complete" },
		});
		expect(results.map((result) => result.ok)).toEqual([true, true, true, true]);
		const failing = evaluateChecks(base, {
			index: { ge: 8 },
			"duplication.groups.production": { lt: 3 },
		});
		expect(failing.map((result) => result.ok)).toEqual([false, false]);
		expect(failing[0]?.detail).toContain("want >= 8");
	});

	test("supports le and reports a null value for absent metrics", () => {
		const [pass, absent] = evaluateChecks(base, {
			"duplication.groups.production": { le: 3 },
			"erosion.eroded-count.production": { eq: 0 },
		});
		expect(pass?.ok).toBe(true);
		expect(absent?.ok).toBe(false);
		expect(absent?.detail).toContain("null");
	});

	test("compares metric and completeness states", () => {
		const withIncomplete = summary("s", 100, {});
		withIncomplete.completeness = "incomplete";
		withIncomplete.metrics["complexity.functions.production"] = {
			state: "incomplete",
			value: null,
		};
		const results = evaluateChecks(withIncomplete, {
			completeness: { state: "incomplete" },
			"complexity.functions.production": { state: "incomplete" },
			"import-cycle.groups": { state: "incomplete" },
		});
		expect(results.map((result) => result.ok)).toEqual([true, true, false]);
		expect(results[2]?.detail).toContain("absent");
	});

	test("a check with no operator never passes", () => {
		const [result] = evaluateChecks(base, { index: {} });
		expect(result?.ok).toBe(false);
		expect(result?.detail).toContain("a check operator");
	});
});

describe("assessPair", () => {
	test("accepts intended moves and holds unrelated metrics to equality", () => {
		const before = summary("a", 10, {
			"duplication.groups.production": 2,
			"import-cycle.groups": 0,
		});
		const after = summary("b", 4, { "duplication.groups.production": 0, "import-cycle.groups": 0 });
		const assessment = assessPair(
			pair({
				expectDecrease: ["duplication.groups.production"],
				expectUnchanged: ["import-cycle.groups"],
				indexDelta: { max: 0 },
			}),
			before,
			after,
		);
		expect(assessment.failures).toEqual([]);
		expect(und(assessment.deltas["duplication.groups.production"])).toEqual({
			before: 2,
			after: 0,
			delta: -2,
		});
		expect(assessment.indexDelta).toBe(-6);
	});

	test("reports each broken expectation with its before/after values", () => {
		const before = summary("a", 10, {
			"duplication.groups.production": 2,
			"erosion.eroded-count.production": 1,
		});
		const after = summary("b", 20, {
			"duplication.groups.production": 2,
			"erosion.eroded-count.production": 2,
		});
		const assessment = assessPair(
			pair({
				expectDecrease: ["duplication.groups.production"],
				expectIncrease: ["import-cycle.groups"],
				expectUnchanged: ["erosion.eroded-count.production"],
				indexDelta: { min: -2, max: 5 },
			}),
			before,
			after,
		);
		expect(assessment.failures).toEqual([
			"duplication.groups.production should decrease (2 → 2)",
			"import-cycle.groups should increase (null → null)",
			"erosion.eroded-count.production should be unchanged (1 → 2)",
			"index delta 10 above maximum 5",
		]);
	});

	test("flags an index delta below the minimum bound", () => {
		const before = summary("a", 10, {});
		const after = summary("b", 5, {});
		const assessment = assessPair(pair({ indexDelta: { min: -2 } }), before, after);
		expect(assessment.failures).toEqual(["index delta -5 below minimum -2"]);
	});
});

/** Narrow a possibly-undefined record entry for assertions. */
function und<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("expected a defined value");
	return value;
}

describe("formatMarkdown", () => {
	test("renders environment, entries, pairs, checks, and the verdict", () => {
		const record: CorpusRecordView = {
			environment: {
				revision: "abc123",
				analyzerVersion: "0.2.0",
				scoringVersion: "0.1.0-provisional",
				schemaVersion: "1.0.0",
				bun: "1.2.23",
				typescript: "6.0.3",
				platform: "linux",
				arch: "x64",
				cpu: "Test CPU",
				memoryMb: 1024,
			},
			entries: [
				{
					id: "clean-small",
					summary: summary("clean-small", 0, {}),
					medianMs: 12.3,
					peakRssMb: 200,
					budgetBreaches: [],
				},
				{
					id: "slow",
					summary: summary("slow", 1, {}),
					medianMs: 9999,
					peakRssMb: 300,
					budgetBreaches: ["median 9999ms exceeds budget 2000ms"],
				},
			],
			checkResults: {
				"clean-small": [{ target: "index", ok: true, detail: "index 0 (want == 0)" }],
			},
			pairs: [
				{
					id: "clone-removal",
					indexBefore: 16,
					indexAfter: 0,
					indexDelta: -16,
					deltas: {
						"duplication.groups.production": { before: 1, after: 0, delta: -1 },
						"duplication.density.production": { before: null, after: null, delta: null },
					},
					failures: [],
				},
				{
					id: "broken-pair",
					indexBefore: 0,
					indexAfter: 1,
					indexDelta: 1,
					deltas: {},
					failures: ["x should decrease (1 → 2)"],
				},
			],
			ok: false,
		};
		const markdown = formatMarkdown(record);
		expect(markdown).toContain("| revision | abc123 |");
		expect(markdown).toContain("0.2.0 / 0.1.0-provisional / 1.0.0");
		expect(markdown).toContain("| clean-small | 1 | 10 | 0 | false | 12 | 200 | ok |");
		expect(markdown).toContain("median 9999ms exceeds budget 2000ms");
		expect(markdown).toContain("### clone-removal (index 16 → 0)");
		expect(markdown).toContain("| duplication.density.production | n/a | n/a | n/a |");
		expect(markdown).toContain("expectations: all held");
		expect(markdown).toContain("FAILURES: x should decrease (1 → 2)");
		expect(markdown).toContain("- ok clean-small: index 0 (want == 0)");
		expect(markdown).toContain("overall: FAIL");
	});
});
