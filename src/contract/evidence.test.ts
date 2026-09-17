import { describe, expect, test } from "bun:test";
import {
	externalProvider,
	fullAnalysis,
	fullCoverage,
	nativeProvider,
	partialCoverage,
} from "./analysis-result.fixtures.ts";
import {
	type EvidenceArea,
	evidenceAreaSchema,
	type ReportAnalysis,
	reportAnalysisSchema,
	rollUpEvidenceCompleteness,
	rollUpScoreCompleteness,
} from "./evidence.ts";
import type { MetricValue } from "./metric.ts";
import { fixtureNativeAnalysis } from "./report.fixtures.ts";

/** A complete metric. */
function metric(id: string, value = 1): MetricValue {
	return { id, state: "complete", value, unit: "count" };
}

/** An incomplete metric (what could not be analyzed is recorded). */
function incompleteMetric(id: string): MetricValue {
	return { id, state: "incomplete", unit: "count", reason: "parse diagnostics" };
}

/** A complete native analysis entry fixture (over the shared fixture identity). */
function nativeEntry(
	metricIds: readonly string[],
	scoring: "scored" | "advisory" = "scored",
): ReportAnalysis {
	return fixtureNativeAnalysis(metricIds, scoring);
}

/** An incomplete native analysis entry fixture: a parse-diagnostic coverage gap. */
function incompleteNativeEntry(metricIds: readonly string[]): ReportAnalysis {
	return {
		...nativeEntry(metricIds),
		state: "incomplete",
		reason: "1 selected file produced parse diagnostics",
		observedCoverage: partialCoverage,
	};
}

/** An advisory external analysis entry fixture. */
function externalEntry(
	state: "unrequested" | "unavailable" | "unsupported" | "incomplete" | "complete",
): ReportAnalysis {
	switch (state) {
		case "unrequested":
			return { scoring: "advisory", metricIds: [], provider: externalProvider, state };
		case "unavailable":
			return {
				scoring: "advisory",
				metricIds: [],
				provider: externalProvider,
				state,
				reason: "pinned tool not installed",
			};
		case "unsupported":
			return {
				scoring: "advisory",
				metricIds: [],
				provider: externalProvider,
				state,
				reason: "capability deferred for this scope",
				location: "trellis.yaml",
			};
		case "incomplete":
			return {
				scoring: "advisory",
				metricIds: [],
				provider: externalProvider,
				state,
				analysis: fullAnalysis,
				reason: "2 of 3 selected files analyzed",
				observedCoverage: partialCoverage,
			};
		case "complete":
			return {
				scoring: "advisory",
				metricIds: [],
				provider: externalProvider,
				state,
				analysis: fullAnalysis,
				observedCoverage: fullCoverage,
			};
	}
}

describe("reportAnalysisSchema", () => {
	test("accepts a scored native analysis and an advisory external analysis", () => {
		const native = nativeEntry(["duplication.density.production"]);
		expect(reportAnalysisSchema.safeParse(native).success).toBe(true);
		const external = externalEntry("complete");
		expect(reportAnalysisSchema.safeParse(external).success).toBe(true);
	});

	test("rejects unsorted or duplicate owned metric ids", () => {
		const unsorted = { ...nativeEntry(["a.one", "a.two"]), metricIds: ["a.two", "a.one"] };
		expect(reportAnalysisSchema.safeParse(unsorted).success).toBe(false);
		const duplicated = { ...nativeEntry(["a.one"]), metricIds: ["a.one", "a.one"] };
		expect(reportAnalysisSchema.safeParse(duplicated).success).toBe(false);
	});

	test("rejects a native entry owning no metric or carrying native measured output", () => {
		const emptyOwnership = nativeEntry([]);
		expect(reportAnalysisSchema.safeParse(emptyOwnership).success).toBe(false);
		const withMetrics = {
			...nativeEntry(["a.one"]),
			metrics: [metric("a.one")],
		};
		expect(reportAnalysisSchema.safeParse(withMetrics).success).toBe(false);
		const withFindings = {
			...nativeEntry(["a.one"]),
			findings: [
				{
					kind: "complexity.hotspot",
					path: "src/a.ts",
					range: { start: { line: 1 }, end: { line: 2 } },
					summary: "CC 23",
				},
			],
		};
		expect(reportAnalysisSchema.safeParse(withFindings).success).toBe(false);
	});

	test("rejects an external entry owning native metric ids", () => {
		const owner = { ...externalEntry("complete"), metricIds: ["duplication.density.production"] };
		expect(reportAnalysisSchema.safeParse(owner).success).toBe(false);
	});

	test("keeps the §16.2 state matrix: an incomplete entry needs its gap, an unrequested one no evidence", () => {
		// An incomplete entry without observed coverage or reason is rejected by
		// the shared analysis-result contract.
		const bare = {
			scoring: "advisory",
			metricIds: [],
			provider: externalProvider,
			state: "incomplete",
			analysis: fullAnalysis,
		};
		expect(reportAnalysisSchema.safeParse(bare).success).toBe(false);
		// An unrequested entry carries no evidence at all.
		expect(reportAnalysisSchema.safeParse(externalEntry("unrequested")).success).toBe(true);
		const relabeled = {
			...externalEntry("unrequested"),
			analysis: fullAnalysis,
		};
		expect(reportAnalysisSchema.safeParse(relabeled).success).toBe(false);
	});
});

describe("evidenceAreaSchema", () => {
	test("accepts unique provider-id-ordered analyses and rejects duplicates or disorder", () => {
		const ordered: EvidenceArea = {
			completeness: "complete",
			analyses: [
				{ ...nativeEntry(["a.one"]), provider: { ...nativeProvider, id: "trellis.alpha" } },
				{ ...nativeEntry(["b.one"]), provider: { ...nativeProvider, id: "trellis.beta" } },
			],
		};
		expect(evidenceAreaSchema.safeParse(ordered).success).toBe(true);
		const first = ordered.analyses[0];
		if (first === undefined) throw new Error("fixture entry missing");
		const duplicated: EvidenceArea = {
			...ordered,
			analyses: [first, { ...first }],
		};
		expect(evidenceAreaSchema.safeParse(duplicated).success).toBe(false);
		const reversed: EvidenceArea = {
			...ordered,
			analyses: [...ordered.analyses].reverse(),
		};
		expect(evidenceAreaSchema.safeParse(reversed).success).toBe(false);
	});
});

describe("rollUpEvidenceCompleteness", () => {
	test("stays complete over complete analyses and complete metrics", () => {
		const analyses = [nativeEntry(["a.one"]), externalEntry("complete")];
		expect(rollUpEvidenceCompleteness(analyses, [metric("a.one")])).toBe("complete");
	});

	test("degrades on any analysis gap, never on unrequested", () => {
		const metrics = [metric("a.one")];
		for (const state of ["incomplete", "unavailable", "unsupported"] as const) {
			expect(
				rollUpEvidenceCompleteness([nativeEntry(["a.one"]), externalEntry(state)], metrics),
			).toBe("incomplete");
		}
		expect(
			rollUpEvidenceCompleteness([nativeEntry(["a.one"]), externalEntry("unrequested")], metrics),
		).toBe("complete");
	});

	test("degrades on an incomplete native metric", () => {
		expect(rollUpEvidenceCompleteness([nativeEntry(["a.one"])], [incompleteMetric("a.one")])).toBe(
			"incomplete",
		);
		// Unsupported and not-applicable metrics are honest states, never gaps.
		const unsupported: MetricValue = { id: "a.two", state: "unsupported", unit: "count" };
		expect(
			rollUpEvidenceCompleteness([nativeEntry(["a.one", "a.two"])], [metric("a.one"), unsupported]),
		).toBe("complete");
	});
});

describe("rollUpScoreCompleteness", () => {
	test("computes score completeness only from the declared scored inputs", () => {
		const scored = nativeEntry(["scored.one"]);
		const advisory = { ...externalEntry("complete"), scoring: "advisory" as const };
		const metrics = { "scored.one": metric("scored.one"), "advisory.one": metric("advisory.one") };
		expect(rollUpScoreCompleteness([scored, advisory], metrics)).toBe("complete");
	});

	test("an incomplete advisory analysis never flips a complete native score", () => {
		const scored = nativeEntry(["scored.one"]);
		const metrics = { "scored.one": metric("scored.one") };
		for (const state of ["incomplete", "unavailable", "unsupported", "unrequested"] as const) {
			const advisory = externalEntry(state);
			expect(rollUpScoreCompleteness([scored, advisory], metrics)).toBe("complete");
		}
	});

	test("a scored analysis gap or an incomplete scored-owned metric marks the score incomplete", () => {
		const metrics = { "scored.one": metric("scored.one") };
		expect(rollUpScoreCompleteness([incompleteNativeEntry(["scored.one"])], metrics)).toBe(
			"incomplete",
		);
		expect(
			rollUpScoreCompleteness([nativeEntry(["scored.one"])], {
				"scored.one": incompleteMetric("scored.one"),
			}),
		).toBe("incomplete");
		// An incomplete metric owned by an advisory analysis never enters the score.
		const advisoryOwnsIt: ReportAnalysis = { ...nativeEntry(["advisory.one"], "advisory") };
		expect(
			rollUpScoreCompleteness([nativeEntry(["scored.one"]), advisoryOwnsIt], {
				"scored.one": metric("scored.one"),
				"advisory.one": incompleteMetric("advisory.one"),
			}),
		).toBe("complete");
	});

	test("an absent scored metric reads as complete only because ownership is validated elsewhere", () => {
		// The rollup itself never invents states: an owned metric missing from
		// the map is the report-level ownership invariant's rejection, not a
		// silent completeness claim — the rollup treats it as not-incomplete so
		// the ownership error is the single honest failure.
		expect(rollUpScoreCompleteness([nativeEntry(["scored.one"])], {})).toBe("complete");
	});
});
