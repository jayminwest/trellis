/**
 * Analysis-result contract tests — the state matrix and provenance rules
 * (SPEC §16.2, AC2/AC3/AC5): contradictory statuses, missing provenance on
 * measured output, namespaced identities, and the empty-successful-output
 * guard (the spike's empty graph).
 *
 * Acceptance paths live in `analysis-result.test.ts`; shared fixtures in
 * `analysis-result.fixtures.ts`.
 */
import { describe, expect, test } from "bun:test";
import { observedCoverageSchema } from "./analysis.ts";
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
import { findingSchema } from "./finding.ts";
import { metricValueSchema } from "./metric.ts";
import { namespacedEvidenceId } from "./provider.ts";

const incomplete = { provider: externalProvider, state: "incomplete" } as const;
const complete = { provider: externalProvider, state: "complete" } as const;

describe("analysisResultSchema state matrix", () => {
	test("rejects an unrequested analysis carrying any evidence", () => {
		for (const extra of [
			{ analysis: fullAnalysis },
			{ reason: "not enabled" },
			{ location: "src/a.ts" },
			{ observedCoverage: fullCoverage },
			{ execution: { durationMs: 1 } },
			{ metrics: [externalMetric] },
			{ findings: [externalFinding] },
			{ cloneEvidence: [externalPair] },
		]) {
			const result = analysisResultSchema.safeParse({
				provider: externalProvider,
				state: "unrequested",
				...extra,
			});
			expect(result.success).toBe(false);
		}
	});

	test("rejects unavailable or unsupported analyses without a reason or with fabricated evidence", () => {
		for (const state of ["unavailable", "unsupported"] as const) {
			const base = { provider: externalProvider, state };
			expect(analysisResultSchema.safeParse(base).success).toBe(false);
			expect(
				analysisResultSchema.safeParse({ ...base, observedCoverage: fullCoverage }).success,
			).toBe(false);
			expect(
				analysisResultSchema.safeParse({ ...base, reason: "missing", metrics: [externalMetric] })
					.success,
			).toBe(false);
			expect(
				analysisResultSchema.safeParse({
					...base,
					reason: "missing",
					cloneEvidence: [externalPair],
				}).success,
			).toBe(false);
		}
	});

	test("rejects an incomplete analysis missing its identity, coverage, or reason", () => {
		expect(
			analysisResultSchema.safeParse({
				...incomplete,
				observedCoverage: partialCoverage,
				reason: "partial",
			}).success,
		).toBe(false);
		expect(
			analysisResultSchema.safeParse({ ...incomplete, analysis: fullAnalysis, reason: "partial" })
				.success,
		).toBe(false);
		expect(
			analysisResultSchema.safeParse({
				...incomplete,
				analysis: fullAnalysis,
				observedCoverage: partialCoverage,
			}).success,
		).toBe(false);
	});

	test("rejects an incomplete analysis whose coverage shows no gap", () => {
		const result = analysisResultSchema.safeParse({
			...incomplete,
			analysis: fullAnalysis,
			observedCoverage: fullCoverage,
			reason: "claims a gap but shows none",
		});
		expect(result.success).toBe(false);
	});

	test("rejects coverage that exceeds the selection", () => {
		const beyondSelection = observedCoverageSchema.parse({
			analyzedFiles: ["src/a.ts", "src/c.ts"],
			diagnostics: [],
			unsupported: [],
		});
		const result = analysisResultSchema.safeParse({
			...incomplete,
			analysis: fullAnalysis,
			observedCoverage: beyondSelection,
			reason: "analyzed beyond the intended scope",
		});
		expect(result.success).toBe(false);
	});

	test("rejects a complete analysis without coverage, with a reason, or with a location", () => {
		expect(analysisResultSchema.safeParse({ ...complete, analysis: fullAnalysis }).success).toBe(
			false,
		);
		expect(
			analysisResultSchema.safeParse({
				...complete,
				analysis: fullAnalysis,
				observedCoverage: fullCoverage,
				reason: "done?",
			}).success,
		).toBe(false);
		expect(
			analysisResultSchema.safeParse({
				...complete,
				analysis: fullAnalysis,
				observedCoverage: fullCoverage,
				location: "src/a.ts",
			}).success,
		).toBe(false);
	});

	test("rejects a complete analysis with diagnostics or unsupported context", () => {
		const withDiagnostics = observedCoverageSchema.parse({
			...fullCoverage,
			diagnostics: [{ message: "parse error" }],
		});
		const withUnsupported = observedCoverageSchema.parse({
			...fullCoverage,
			unsupported: [{ path: "src/a.ts", reason: "outside the parser set" }],
		});
		for (const observedCoverage of [withDiagnostics, withUnsupported]) {
			const result = analysisResultSchema.safeParse({
				...complete,
				analysis: fullAnalysis,
				observedCoverage,
			});
			expect(result.success).toBe(false);
		}
	});

	test("rejects empty successful output claiming complete coverage (the spike's empty graph)", () => {
		const result = analysisResultSchema.safeParse({
			...complete,
			analysis: fullAnalysis,
			observedCoverage: emptyCoverage,
			execution: { exitCode: 0, durationMs: 26 },
		});
		expect(result.success).toBe(false);
		const honest = analysisResultSchema.safeParse({
			...incomplete,
			analysis: fullAnalysis,
			observedCoverage: emptyCoverage,
			reason: "the process exited 0 with an empty graph",
			execution: { exitCode: 0, durationMs: 26 },
		});
		expect(honest.success).toBe(true);
	});

	test("rejects partial output claiming complete coverage", () => {
		const result = analysisResultSchema.safeParse({
			...complete,
			analysis: fullAnalysis,
			observedCoverage: partialCoverage,
		});
		expect(result.success).toBe(false);
	});
});

describe("analysisResultSchema provenance and namespacing", () => {
	test("rejects measured output without the analysis identity that produced it", () => {
		const result = analysisResultSchema.safeParse({
			...complete,
			observedCoverage: fullCoverage,
			metrics: [externalMetric],
		});
		expect(result.success).toBe(false);
	});

	test("rejects external metrics and findings outside the provider namespace", () => {
		const unnamespacedMetric = metricValueSchema.parse({
			id: "duplication.pairs",
			state: "complete",
			value: 1,
			unit: "count",
		});
		const foreignMetric = metricValueSchema.parse({
			id: namespacedEvidenceId("knip", "pairs"),
			state: "complete",
			value: 1,
			unit: "count",
		});
		const unnamespacedFinding = findingSchema.parse({
			kind: "clone-pair",
			path: "src/a.ts",
			range: { start: { line: 3 }, end: { line: 17 } },
			summary: "renamed copy",
		});
		for (const metrics of [[unnamespacedMetric], [foreignMetric]]) {
			const result = analysisResultSchema.safeParse({
				...complete,
				analysis: fullAnalysis,
				observedCoverage: fullCoverage,
				metrics,
			});
			expect(result.success).toBe(false);
		}
		const result = analysisResultSchema.safeParse({
			...complete,
			analysis: fullAnalysis,
			observedCoverage: fullCoverage,
			findings: [unnamespacedFinding],
		});
		expect(result.success).toBe(false);
	});

	test("rejects native identities using the reserved provider namespace", () => {
		const reservedMetric = metricValueSchema.parse({
			id: namespacedEvidenceId("jscpd", "pairs"),
			state: "complete",
			value: 1,
			unit: "count",
		});
		const reservedFinding = findingSchema.parse({
			kind: namespacedEvidenceId("jscpd", "clone-pair"),
			path: "src/a.ts",
			range: { start: { line: 3 }, end: { line: 17 } },
			summary: "native analyzer carrying external evidence",
		});
		for (const evidence of [{ metrics: [reservedMetric] }, { findings: [reservedFinding] }]) {
			const result = analysisResultSchema.safeParse({
				provider: nativeProvider,
				state: "complete",
				analysis: fullAnalysis,
				observedCoverage: fullCoverage,
				...evidence,
			});
			expect(result.success).toBe(false);
		}
	});
});
