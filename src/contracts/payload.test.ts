import { describe, expect, test } from "bun:test";
import { canonicalStringify, fingerprintPayload, measurementPayload } from "./payload.ts";
import { auditReportSchema } from "./report.ts";
import { SCHEMA_VERSION, SCORING_VERSION } from "./versions.ts";

function buildReport(auditedAt: string, durationMs: number, index = 12) {
	return auditReportSchema.parse({
		schemaVersion: SCHEMA_VERSION,
		analyzerVersion: "0.2.0",
		scoringVersion: SCORING_VERSION,
		repo: { root: "/abs/path", identity: "github.com/os-eco/trellis" },
		sourceCoverage: { production: { files: 2, sloc: 40 }, test: { files: 1, sloc: 10 } },
		completeness: "complete",
		metrics: {
			"complexity.cc.p90": { id: "complexity.cc.p90", state: "complete", value: 9, unit: "cc" },
		},
		score: {
			index,
			direction: "lower-is-better",
			partial: false,
			contributions: [
				{ dimension: "complexity-erosion", points: 12, metricIds: ["complexity.cc.p90"] },
			],
		},
		findings: [],
		safeguards: [],
		run: { auditedAt, durationMs },
	});
}

describe("measurementPayload", () => {
	test("strips run metadata from the report", () => {
		const payload = measurementPayload(buildReport("2026-09-15T18:53:18Z", 812));
		expect("run" in payload).toBe(false);
	});

	test("equalizes reports that differ only in timestamps and timings", () => {
		const first = measurementPayload(buildReport("2026-09-15T18:53:18Z", 812));
		const second = measurementPayload(buildReport("2026-12-01T00:00:00Z", 3));
		expect(first).toEqual(second);
		expect(fingerprintPayload(first)).toBe(fingerprintPayload(second));
	});

	test("distinguishes reports whose measurements differ", () => {
		const first = measurementPayload(buildReport("2026-09-15T18:53:18Z", 812, 12));
		const other = measurementPayload(buildReport("2026-09-15T18:53:18Z", 812, 13));
		expect(fingerprintPayload(other)).not.toBe(fingerprintPayload(first));
	});
});

describe("canonicalStringify", () => {
	test("is stable across key insertion order", () => {
		const a = canonicalStringify({ b: 1, a: { d: 2, c: 3 } });
		const b = canonicalStringify({ a: { c: 3, d: 2 }, b: 1 });
		expect(a).toBe(b);
	});

	test("preserves array order", () => {
		expect(canonicalStringify([2, 1])).not.toBe(canonicalStringify([1, 2]));
	});

	test("drops undefined entries", () => {
		expect(canonicalStringify({ a: undefined, b: 1 })).toBe(canonicalStringify({ b: 1 }));
	});
});
