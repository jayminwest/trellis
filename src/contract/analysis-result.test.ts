/**
 * Analysis-result contract tests — acceptance paths (SPEC §16.2, AC4/AC5).
 *
 * The state-matrix and namespacing rejection cases live in
 * `analysis-result.states.test.ts`; shared fixtures in
 * `analysis-result.fixtures.ts`.
 */
import { describe, expect, test } from "bun:test";
import { analysisIdentitySchema, observedCoverageSchema } from "./analysis.ts";
import {
	emptyCoverage,
	externalFinding,
	externalMetric,
	externalPair,
	externalProvider,
	fullAnalysis,
	fullCoverage,
	nativeProvider,
	partialCoverage,
} from "./analysis-result.fixtures.ts";
import { analysisResultSchema } from "./analysis-result.ts";
import { metricValueSchema } from "./metric.ts";

describe("analysisResultSchema", () => {
	test("accepts an unrequested analysis with no evidence", () => {
		const parsed = analysisResultSchema.parse({
			provider: externalProvider,
			state: "unrequested",
		});
		expect(parsed.state).toBe("unrequested");
	});

	test("accepts unavailable and unsupported analyses located with a reason", () => {
		for (const state of ["unavailable", "unsupported"] as const) {
			const parsed = analysisResultSchema.parse({
				provider: externalProvider,
				state,
				reason:
					state === "unavailable"
						? "pinned binary missing"
						: "deferred by the distribution decision",
				location: "bin/jscpd",
				analysis: fullAnalysis,
			});
			expect(parsed.state).toBe(state);
		}
	});

	test("accepts an incomplete analysis showing its coverage gap", () => {
		const parsed = analysisResultSchema.parse({
			provider: externalProvider,
			state: "incomplete",
			analysis: fullAnalysis,
			observedCoverage: partialCoverage,
			reason: "the supported typescript parser was missing",
			metrics: [externalMetric],
			findings: [externalFinding],
			cloneEvidence: [externalPair],
		});
		expect(parsed.observedCoverage?.analyzedFiles).toEqual(["src/a.ts"]);
	});

	test("accepts a complete analysis with namespaced external evidence", () => {
		const parsed = analysisResultSchema.parse({
			provider: externalProvider,
			state: "complete",
			analysis: fullAnalysis,
			observedCoverage: fullCoverage,
			execution: { durationMs: 35, exitCode: 0 },
			metrics: [externalMetric],
			findings: [externalFinding],
			cloneEvidence: [externalPair],
		});
		expect(parsed.metrics?.[0]?.id).toBe("provider.jscpd.pairs");
	});

	test("accepts a complete native analysis carrying native identities", () => {
		const parsed = analysisResultSchema.parse({
			provider: nativeProvider,
			state: "complete",
			analysis: fullAnalysis,
			observedCoverage: fullCoverage,
			metrics: [
				metricValueSchema.parse({
					id: "duplication.density",
					state: "complete",
					value: 0.03,
					unit: "ratio",
					numerator: 40,
					denominator: 1328,
				}),
			],
		});
		expect(parsed.provider.kind).toBe("native");
	});

	test("accepts a complete analysis over an empty selection", () => {
		const emptySelection = analysisIdentitySchema.parse({
			...fullAnalysis,
			selection: { sourceSets: ["production"], files: [] },
		});
		const parsed = analysisResultSchema.parse({
			provider: externalProvider,
			state: "complete",
			analysis: emptySelection,
			observedCoverage: emptyCoverage,
		});
		expect(parsed.observedCoverage?.analyzedFiles).toEqual([]);
	});

	test("rejects unknown result keys", () => {
		const result = analysisResultSchema.safeParse({
			provider: externalProvider,
			state: "unrequested",
			policy: "required",
		});
		expect(result.success).toBe(false);
	});

	test("rejects coverage outside the observed-coverage shape", () => {
		const result = analysisResultSchema.safeParse({
			provider: externalProvider,
			state: "complete",
			analysis: fullAnalysis,
			observedCoverage: { ...emptyCoverage, analyzedFiles: ["/abs/a.ts"] },
		});
		expect(result.success).toBe(false);
		expect(
			observedCoverageSchema.safeParse({ ...emptyCoverage, analyzedFiles: ["/abs/a.ts"] }).success,
		).toBe(false);
	});
});
