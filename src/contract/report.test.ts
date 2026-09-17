import { describe, expect, test } from "bun:test";
import { type AuditReport, auditReportSchema, measurementPayload } from "./report.ts";

function baseReport(): AuditReport {
	return {
		schemaVersion: "1.0.0",
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
				path: "src/report/build.ts",
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

function withIncompleteMetric(report: ReturnType<typeof baseReport>) {
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

describe("auditReportSchema", () => {
	test("round-trips a full valid report", () => {
		const report = baseReport();
		expect(auditReportSchema.parse(report)).toEqual(report);
	});

	test("keeps source coverage distinct from analysis completeness", () => {
		const report = withIncompleteMetric(baseReport());
		const parsed = auditReportSchema.parse({
			...report,
			completeness: "incomplete",
			score: { ...report.score, partial: true },
		});
		// Test-source volume is coverage; an incomplete metric degrades completeness.
		expect(parsed.sourceCoverage.test.files).toBe(96);
		expect(parsed.completeness).toBe("incomplete");
		expect(parsed.score.partial).toBe(true);
	});

	test("rejects missing version data", () => {
		for (const key of ["schemaVersion", "analyzerVersion", "scoringVersion"] as const) {
			const report = { ...baseReport(), [key]: undefined };
			expect(auditReportSchema.safeParse(report).success).toBe(false);
		}
	});

	test("rejects an out-of-range index and a wrong direction literal", () => {
		const report = baseReport();
		expect(
			auditReportSchema.safeParse({ ...report, score: { ...report.score, index: 101 } }).success,
		).toBe(false);
		expect(
			auditReportSchema.safeParse({ ...report, score: { ...report.score, index: -1 } }).success,
		).toBe(false);
		expect(
			auditReportSchema.safeParse({
				...report,
				score: { ...report.score, direction: "higher-is-better" },
			}).success,
		).toBe(false);
	});

	test("rejects a complete completeness claim over an incomplete metric", () => {
		const report = withIncompleteMetric(baseReport());
		expect(
			auditReportSchema.safeParse({ ...report, score: { ...report.score, partial: true } }).success,
		).toBe(false);
	});

	test("rejects an incomplete completeness claim over only complete metrics", () => {
		const report = baseReport();
		expect(
			auditReportSchema.safeParse({
				...report,
				completeness: "incomplete",
				score: { ...report.score, partial: true },
			}).success,
		).toBe(false);
	});

	test("rejects an unflagged headline when a metric is incomplete", () => {
		const report = withIncompleteMetric(baseReport());
		expect(auditReportSchema.safeParse({ ...report, completeness: "incomplete" }).success).toBe(
			false,
		);
	});

	test("rejects a metrics key that disagrees with the metric id", () => {
		const report = baseReport();
		const [metric] = Object.values(report.metrics);
		expect(
			auditReportSchema.safeParse({ ...report, metrics: { "other.id": metric } }).success,
		).toBe(false);
	});

	test("rejects a contribution that references an unknown metric", () => {
		const report = baseReport();
		const score = {
			...report.score,
			contributions: [{ dimension: "duplication", points: 12, metricIds: ["duplication.missing"] }],
		};
		expect(auditReportSchema.safeParse({ ...report, score }).success).toBe(false);
	});

	test("accepts run metadata but keeps it out of the measurement payload", () => {
		const report = {
			...baseReport(),
			run: { auditedAt: "2026-09-16T10:00:00.000Z", durationMs: 812.5 },
		};
		const parsed = auditReportSchema.parse(report);
		expect(parsed.run?.auditedAt).toBe("2026-09-16T10:00:00.000Z");
		const payload = measurementPayload(parsed);
		expect("run" in payload).toBe(false);
	});
});

describe("measurementPayload", () => {
	test("excludes timestamps and timings from equality inputs", () => {
		const first = auditReportSchema.parse({
			...baseReport(),
			run: { auditedAt: "2026-09-16T10:00:00.000Z", durationMs: 812.5 },
		});
		const second = auditReportSchema.parse({
			...baseReport(),
			run: { auditedAt: "2026-09-17T22:41:03.000Z", durationMs: 1203 },
		});
		expect(measurementPayload(first)).toEqual(measurementPayload(second));
		expect(JSON.stringify(measurementPayload(first))).toBe(
			JSON.stringify(measurementPayload(second)),
		);
	});

	test("equals the raw report when no run metadata is present", () => {
		const report = auditReportSchema.parse(baseReport());
		expect(measurementPayload(report)).toEqual(report);
	});
});
