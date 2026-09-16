import { describe, expect, test } from "bun:test";
import { auditReportSchema } from "./report.ts";
import { SCHEMA_VERSION, SCORING_VERSION } from "./versions.ts";

const densityMetric = {
	id: "duplication.density",
	state: "complete",
	value: 0.031,
	unit: "ratio",
	numerator: 412,
	denominator: 13280,
};

const base = {
	schemaVersion: SCHEMA_VERSION,
	analyzerVersion: "0.2.0",
	scoringVersion: SCORING_VERSION,
	repo: { root: "/abs/path", identity: "github.com/os-eco/trellis" },
	sourceCoverage: {
		production: { files: 210, sloc: 13280 },
		test: { files: 96, sloc: 5100 },
	},
	completeness: "complete",
	metrics: { "duplication.density": densityMetric },
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
	safeguards: [{ id: "pre-commit-hook", evidence: "configured", locations: [] }],
};

describe("auditReportSchema", () => {
	test("round-trips a well-formed report", () => {
		expect(auditReportSchema.parse(base)).toEqual(base);
	});

	test("accepts run metadata as the only non-deterministic field group", () => {
		const report = {
			...base,
			run: { auditedAt: "2026-09-15T18:53:18Z", durationMs: 812 },
		};
		expect(auditReportSchema.parse(report)).toEqual(report);
	});

	test("rejects a missing schema version", () => {
		const { schemaVersion: _v, ...rest } = base;
		expect(auditReportSchema.safeParse(rest).success).toBe(false);
	});

	test("rejects a missing analyzer version", () => {
		const { analyzerVersion: _v, ...rest } = base;
		expect(auditReportSchema.safeParse(rest).success).toBe(false);
	});

	test("rejects a missing scoring version", () => {
		const { scoringVersion: _v, ...rest } = base;
		expect(auditReportSchema.safeParse(rest).success).toBe(false);
	});

	test("rejects a malformed version string", () => {
		expect(auditReportSchema.safeParse({ ...base, schemaVersion: "1.0" }).success).toBe(false);
	});

	test("rejects an out-of-range index", () => {
		const score = { ...base.score, index: 101 };
		expect(auditReportSchema.safeParse({ ...base, score }).success).toBe(false);
	});

	test("rejects a non-finite index", () => {
		const score = { ...base.score, index: Number.NaN };
		expect(auditReportSchema.safeParse({ ...base, score }).success).toBe(false);
	});

	test("rejects a misleading complete state over an incomplete metric", () => {
		const metrics = {
			"duplication.density": {
				id: "duplication.density",
				state: "incomplete",
				unit: "ratio",
				reason: "corpus exceeds the declared memory budget",
			},
		};
		expect(auditReportSchema.safeParse({ ...base, metrics }).success).toBe(false);
	});

	test("accepts an incomplete report with a flagged partial score", () => {
		const metrics = {
			"duplication.density": {
				id: "duplication.density",
				state: "incomplete",
				unit: "ratio",
				reason: "corpus exceeds the declared memory budget",
			},
		};
		const score = { ...base.score, partial: true };
		const report = { ...base, completeness: "incomplete", metrics, score };
		expect(auditReportSchema.safeParse(report).success).toBe(true);
	});

	test("accepts an incomplete report with the score withheld", () => {
		const { score: _s, ...rest } = base;
		const report = { ...rest, completeness: "incomplete" };
		expect(auditReportSchema.safeParse(report).success).toBe(true);
	});

	test("rejects a complete report with the score withheld", () => {
		const { score: _s, ...rest } = base;
		expect(auditReportSchema.safeParse(rest).success).toBe(false);
	});

	test("rejects a complete report carrying a partial score", () => {
		const score = { ...base.score, partial: true };
		expect(auditReportSchema.safeParse({ ...base, score }).success).toBe(false);
	});

	test("rejects a metrics map key that mismatches the metric id", () => {
		const metrics = { "duplication.other": densityMetric };
		expect(auditReportSchema.safeParse({ ...base, metrics }).success).toBe(false);
	});

	test("rejects a contribution referencing an unknown metric", () => {
		const score = {
			...base.score,
			contributions: [{ dimension: "duplication", points: 12, metricIds: ["duplication.other"] }],
		};
		expect(auditReportSchema.safeParse({ ...base, score }).success).toBe(false);
	});

	test("rejects a finding with an invalid range", () => {
		const findings = [
			{
				kind: "complexity.hotspot",
				path: "src/report/build.ts",
				range: { start: { line: 128 }, end: { line: 41 } },
				summary: "inverted",
			},
		];
		expect(auditReportSchema.safeParse({ ...base, findings }).success).toBe(false);
	});

	test("rejects unknown keys", () => {
		expect(auditReportSchema.safeParse({ ...base, grade: "B" }).success).toBe(false);
	});
});
