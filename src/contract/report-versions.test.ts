import { describe, expect, test } from "bun:test";
import type { ReportAnalysis } from "./evidence.ts";
import { fixtureNativeAnalysis, fixtureNativeProvider } from "./report.fixtures.ts";
import {
	auditReportSchema,
	carriedAnalyses,
	type EvidenceAuditReport,
	measurementPayload,
	type PreProviderAuditReport,
} from "./report.ts";
import { PRE_PROVIDER_SCHEMA_VERSION, SCHEMA_VERSION } from "./version.ts";

/**
 * Version-aware report-contract tests (SPEC §16.6, trellis-a24d): the
 * evidence-carrying schema-1.1.0 reports — per-analysis provenance/status,
 * overall evidence completeness independent from score completeness — and
 * the pre-provider schema-1.0.0 artifacts that must keep their original
 * interpretation.
 */

/** Parse a report and narrow it to the evidence-carrying member (any other version throws). */
function parseEvidenceReport(report: unknown): EvidenceAuditReport {
	const parsed = auditReportSchema.parse(report);
	if (parsed.schemaVersion !== SCHEMA_VERSION) {
		throw new Error(`expected schema version ${SCHEMA_VERSION}, got ${parsed.schemaVersion}`);
	}
	return parsed;
}

/** The measurement body both versions share, as a pre-provider report. */
function baseReport(): PreProviderAuditReport {
	return {
		schemaVersion: PRE_PROVIDER_SCHEMA_VERSION,
		analyzerVersion: "0.2.0",
		scoringVersion: "0.1.0-provisional",
		repo: { root: "/abs/path", identity: "github.com/jayminwest/trellis" },
		sourceCoverage: {
			production: { files: 210, sloc: 13280 },
			test: { files: 96, sloc: 5100 },
			generated: { files: 4 },
			unsupported: { files: 30, note: "non-TS sources, not analyzed" },
		},
		completeness: "complete",
		metrics: {
			"duplication.density": {
				id: "duplication.density",
				state: "complete",
				value: 0.031,
				unit: "ratio",
				numerator: 412,
				denominator: 13280,
			},
		},
		score: {
			index: 27,
			direction: "lower-is-better",
			partial: false,
			contributions: [{ dimension: "duplication", points: 12, metricIds: ["duplication.density"] }],
		},
		findings: [
			{
				kind: "complexity.hotspot",
				path: "src/audit/audit.ts",
				range: { start: { line: 41 }, end: { line: 128 } },
				summary: "CC 23, mass 214",
			},
		],
		safeguards: [
			{
				id: "pre-commit-hook",
				evidence: "structurally-wired",
				locations: [{ path: "scripts/hooks/pre-commit" }],
			},
		],
	};
}

/** A scored native analysis entry owning `metricIds` (the duplication analyzer's identity). */
function scoredNative(metricIds: readonly string[]): ReportAnalysis {
	return {
		...fixtureNativeAnalysis(metricIds),
		provider: { ...fixtureNativeProvider, id: "trellis.duplication" },
	};
}

/** baseReport with one incomplete metric (the §3.3 native degradation). */
function withIncompleteMetric(report: PreProviderAuditReport): PreProviderAuditReport {
	return {
		...report,
		metrics: {
			...report.metrics,
			"import-cycle.density": {
				id: "import-cycle.density",
				state: "incomplete",
				unit: "ratio",
				reason: "12 imports unresolved without node_modules",
			},
		},
	};
}

/** A minimal valid schema-1.1.0 report: one scored native analysis owning the measured metric. */
function evidenceReport(): EvidenceAuditReport {
	return {
		...baseReport(),
		schemaVersion: SCHEMA_VERSION,
		findings: baseReport().findings.map((finding) => ({
			...finding,
			identity: { version: "1.0.0", state: "ambiguous", reason: "anonymous" },
		})),
		evidence: {
			completeness: "complete",
			analyses: [scoredNative(["duplication.density"])],
		},
	};
}

describe("auditReportSchema (version-aware, §16.6)", () => {
	test("round-trips a full valid evidence-carrying report", () => {
		const report = evidenceReport();
		const parsed = auditReportSchema.parse(report);
		expect(parsed).toEqual(report);
		expect(parsed.schemaVersion).toBe(SCHEMA_VERSION);
	});

	test("rejects a pre-provider report relabeled with an evidence area (AC4)", () => {
		const relabeled = {
			...evidenceReport(),
			schemaVersion: PRE_PROVIDER_SCHEMA_VERSION,
		};
		const result = auditReportSchema.safeParse(relabeled);
		expect(result.success).toBe(false);
		// And a pre-provider report keeps its original interpretation: the
		// headline still folds the metric-state rollup.
		const legacy = withIncompleteMetric(baseReport());
		expect(auditReportSchema.safeParse({ ...legacy, completeness: "incomplete" }).success).toBe(
			false,
		);
	});

	test("rejects unknown schema versions actionably, naming the supported ones (AC4)", () => {
		for (const version of ["0.9.0", "1.3.0", "2.0.0"]) {
			const result = auditReportSchema.safeParse({ ...evidenceReport(), schemaVersion: version });
			expect(result.success).toBe(false);
			if (result.success) throw new Error("unreachable");
			const message = result.error.issues.map((issue) => issue.message).join("; ");
			expect(message).toContain("1.0.0");
			expect(message).toContain("1.1.0");
		}
	});

	test("carriedAnalyses reads version-aware: pre-provider reports carry none, never provider provenance", () => {
		expect(carriedAnalyses(baseReport())).toEqual([]);
		const report = parseEvidenceReport(evidenceReport());
		expect(carriedAnalyses(report).map((analysis) => analysis.provider.id)).toEqual([
			"trellis.duplication",
		]);
	});
});

describe("measurementPayload (versioned reports)", () => {
	test("excludes run metadata from equality inputs on both versions", () => {
		const first = parseEvidenceReport({
			...evidenceReport(),
			run: { auditedAt: "2026-09-16T10:00:00.000Z", durationMs: 812.5 },
		});
		const second = parseEvidenceReport({
			...evidenceReport(),
			run: { auditedAt: "2026-09-17T22:41:03.000Z", durationMs: 1203 },
		});
		expect(measurementPayload(first)).toEqual(measurementPayload(second));
		expect(JSON.stringify(measurementPayload(first))).toBe(
			JSON.stringify(measurementPayload(second)),
		);
		// The evidence area is part of the deterministic payload.
		const payload = measurementPayload(first);
		expect(payload.evidence.analyses).toHaveLength(1);
		expect("run" in payload).toBe(false);
	});
});
