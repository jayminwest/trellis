import { describe, expect, test } from "bun:test";
import { compareReports } from "./compare.ts";
import { assessScoredBasis } from "./compatibility.ts";
import {
	completeMetric,
	evidenceReport,
	jscpdAnalysis,
	nativeComplexityAnalysis,
	preProviderReport,
} from "./fixtures.ts";

/**
 * Scored-basis compatibility (SPEC §3.5, §9, §16.6 — trellis-bd0c): the
 * native index/metric/finding comparison is gated per basis. Advisory-only
 * changes never enter it; scored measurement/scoring changes fail closed;
 * versioned artifact pairs (1.0.0/1.1.0) are explicit about what compares.
 */

describe("assessScoredBasis advisory-only changes", () => {
	test("adding an optional external analysis preserves an otherwise compatible scored basis", () => {
		const baseline = evidenceReport([nativeComplexityAnalysis()]);
		const current = evidenceReport([nativeComplexityAnalysis(), jscpdAnalysis()], { index: 14 });
		const basis = assessScoredBasis(baseline, current);
		expect(basis.comparable).toBe(true);
		expect(basis.issues).toEqual([]);
		// The native comparison itself is untouched by the provider addition.
		const comparison = compareReports(baseline, current);
		expect(comparison.score).toEqual({ baseline: 10, current: 14, delta: 4 });
		expect(comparison.evidence.providers.find((p) => p.providerId === "jscpd")?.status).toBe(
			"absent-on-baseline",
		);
	});

	test("removing an optional external analysis preserves the scored basis", () => {
		const baseline = evidenceReport([nativeComplexityAnalysis(), jscpdAnalysis()]);
		const current = evidenceReport([nativeComplexityAnalysis()]);
		const basis = assessScoredBasis(baseline, current);
		expect(basis.comparable).toBe(true);
		expect(
			compareReports(baseline, current).evidence.providers.find((p) => p.providerId === "jscpd")
				?.status,
		).toBe("absent-on-current");
	});

	test("adding an advisory native analysis and its metrics keeps the scored catalogs comparable", () => {
		const baseline = evidenceReport([nativeComplexityAnalysis()]);
		const current = evidenceReport([
			nativeComplexityAnalysis(),
			nativeComplexityAnalysis({
				id: "trellis.wrappers",
				metricIds: ["wrapper.forwarding"],
				scoring: "advisory",
			}),
		]);
		const basis = assessScoredBasis(baseline, current);
		expect(basis.comparable).toBe(true);
		expect(basis.issues).toEqual([]);
		// The advisory metrics appear in the diff with an absent baseline side — never as a refusal.
		const comparison = compareReports(baseline, current);
		const delta = comparison.metrics?.find((d) => d.id === "wrapper.forwarding");
		expect(delta?.baseline).toBeNull();
		expect(delta?.current).toEqual({ state: "complete", value: 1 });
		expect(delta?.delta).toBeUndefined();
	});
});

describe("assessScoredBasis scored measurement changes", () => {
	test("a scored analysis recording different measurement semantics fails closed per measurement", () => {
		const baseline = evidenceReport([nativeComplexityAnalysis()]);
		const current = evidenceReport([
			nativeComplexityAnalysis({ parser: { engine: "trellis.typescript", version: "6.0.0" } }),
		]);
		const basis = assessScoredBasis(baseline, current);
		expect(basis.comparable).toBe(false);
		expect(basis.issues.map((issue) => issue.code)).toEqual(["scored-measurement"]);
		// No numeric score-regression comparison exists to read (§9 fail-closed).
		const comparison = compareReports(baseline, current);
		expect(comparison.score).toBeUndefined();
		expect(comparison.metrics).toBeUndefined();
		expect(comparison.findings).toBeUndefined();
		// The evidence dimension carries the explicit parser reason.
		const native = comparison.evidence.providers.find((p) => p.providerId === "trellis.complexity");
		expect(native?.status).toBe("noncomparable");
		expect(native?.reasons.map((reason) => reason.code)).toEqual(["parser-identity"]);
	});

	test("a changed declared scored analysis set fails closed on the scoring basis", () => {
		const baseline = evidenceReport([nativeComplexityAnalysis(), jscpdAnalysis()]);
		const current = evidenceReport([
			nativeComplexityAnalysis(),
			jscpdAnalysis({ scoring: "scored" }),
		]);
		const basis = assessScoredBasis(baseline, current);
		expect(basis.comparable).toBe(false);
		expect(basis.issues.map((issue) => issue.code)).toEqual(["scoring-basis"]);
		expect(compareReports(baseline, current).score).toBeUndefined();
	});

	test("a changed scored metric catalog still fails closed under the established rule", () => {
		const baseline = evidenceReport([nativeComplexityAnalysis()]);
		const current = evidenceReport([
			nativeComplexityAnalysis({ metricIds: ["complexity.average-cc", "complexity.max-cc"] }),
		]);
		const basis = assessScoredBasis(baseline, current);
		expect(basis.comparable).toBe(false);
		expect(basis.issues.map((issue) => issue.code)).toEqual(["metric-set"]);
	});
});

describe("assessScoredBasis versioned artifact pairs", () => {
	test("refuses modern/historical schemas in both directions even with matching analyzer fields", () => {
		const modern = evidenceReport([nativeComplexityAnalysis()]);
		for (const old of [
			preProviderReport(),
			evidenceReport([nativeComplexityAnalysis()], { schemaVersion: "1.1.0" }),
		]) {
			for (const [baseline, current] of [
				[old, modern],
				[modern, old],
			] as const) {
				const comparison = compareReports(baseline, current);
				expect(comparison.compatibility.comparable).toBe(false);
				expect(comparison.compatibility.issues.map((issue) => issue.code)).toContain(
					"schema-version",
				);
				expect(comparison.findings).toBeUndefined();
			}
		}
	});

	test("retains scored-input compatibility checks for historical evidence schemas", () => {
		const baseline = evidenceReport([nativeComplexityAnalysis()], { schemaVersion: "1.1.0" });
		const current = evidenceReport(
			[nativeComplexityAnalysis(), jscpdAnalysis({ scoring: "scored" })],
			{ schemaVersion: "1.1.0" },
		);
		expect(assessScoredBasis(baseline, current).issues.map((issue) => issue.code)).toContain(
			"scoring-basis",
		);
	});

	test("a 1.0.0 vs 1.1.0 pair compares the scored basis explicitly with a schema-span caveat", () => {
		const baseline = preProviderReport();
		const current = evidenceReport([nativeComplexityAnalysis(), jscpdAnalysis()], {
			index: 15,
			schemaVersion: "1.1.0",
		});
		const basis = assessScoredBasis(baseline, current);
		expect(basis.comparable).toBe(true);
		expect(basis.issues).toEqual([]);
		expect(basis.caveats.map((caveat) => caveat.code)).toContain("schema-span");
		const comparison = compareReports(baseline, current);
		expect(comparison.score).toEqual({ baseline: 10, current: 15, delta: 5 });
		// The pre-provider side's provider evidence reads as unrequested — never a regression.
		const jscpd = comparison.evidence.providers.find((p) => p.providerId === "jscpd");
		expect(jscpd?.status).toBe("absent-on-baseline");
		expect(jscpd?.reasons[0]?.message).toContain("predates the provider-evidence area");
	});

	test("the reverse span reads the current side as unrequested", () => {
		const baseline = evidenceReport([nativeComplexityAnalysis(), jscpdAnalysis()], {
			schemaVersion: "1.1.0",
		});
		const current = preProviderReport({
			"complexity.average-cc": completeMetric("complexity.average-cc"),
		});
		const comparison = compareReports(baseline, current);
		expect(comparison.compatibility.comparable).toBe(true);
		expect(comparison.evidence.providers.find((p) => p.providerId === "jscpd")?.status).toBe(
			"absent-on-current",
		);
	});

	test("old-old pairs compare under the original interpretation with no evidence area", () => {
		const baseline = preProviderReport();
		const current = preProviderReport({
			"complexity.average-cc": completeMetric("complexity.average-cc", 2),
		});
		const comparison = compareReports(baseline, current);
		expect(comparison.compatibility.comparable).toBe(true);
		expect(comparison.compatibility.caveats.map((caveat) => caveat.code)).toEqual([
			"configuration-unverifiable",
		]);
		expect(comparison.evidence.providers).toEqual([]);
		expect(comparison.metrics?.find((d) => d.id === "complexity.average-cc")?.delta).toBe(1);
	});

	test("new-new pairs compare both bases per measurement", () => {
		const baseline = evidenceReport([nativeComplexityAnalysis(), jscpdAnalysis()]);
		const current = evidenceReport(
			[
				nativeComplexityAnalysis(),
				jscpdAnalysis({ metrics: [completeMetric("provider.jscpd.pairs", 3)] }),
			],
			{ index: 12 },
		);
		const comparison = compareReports(baseline, current);
		expect(comparison.compatibility.comparable).toBe(true);
		expect(
			comparison.evidence.providers.map((provider) => `${provider.providerId}:${provider.status}`),
		).toEqual(["jscpd:comparable", "trellis.complexity:comparable"]);
		const jscpd = comparison.evidence.providers.find((p) => p.providerId === "jscpd");
		expect(jscpd?.metrics?.find((delta) => delta.id === "provider.jscpd.pairs")?.delta).toBe(2);
		expect(JSON.stringify(comparison)).toBe(JSON.stringify(compareReports(baseline, current)));
	});
});
