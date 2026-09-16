import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type AuditReport, auditReportSchema, measurementPayload } from "../contract/index.ts";
import { auditFixture, FIXTURE_KINDS, type FixtureReport } from "./audit-fixtures.ts";
import { renderAuditJson } from "./audit-json.ts";

const fixtures = new Map<string, FixtureReport>();

beforeAll(async () => {
	for (const kind of FIXTURE_KINDS) {
		fixtures.set(kind, await auditFixture(kind));
	}
});

afterAll(async () => {
	await Promise.all([...fixtures.values()].map((fixture) => fixture.cleanup()));
});

/** The report of one fixture kind. */
function report(kind: string): AuditReport {
	const fixture = fixtures.get(kind);
	if (fixture === undefined) throw new Error(`fixture ${kind} not built`);
	return fixture.report;
}

describe("renderAuditJson", () => {
	test("carries the full structured report for every fixture kind", () => {
		for (const kind of FIXTURE_KINDS) {
			const expected = report(kind);
			const parsed = auditReportSchema.parse(JSON.parse(renderAuditJson(expected)));
			expect(parsed).toEqual(expected);
			expect(parsed.findings.length).toBe(expected.findings.length);
			expect(Object.keys(parsed.metrics)).toEqual(Object.keys(expected.metrics));
			expect(parsed.safeguards.length).toBe(expected.safeguards.length);
		}
	});

	test("serializes byte-identically for repeated renders of the same report", () => {
		const sloppy = report("sloppy");
		expect(renderAuditJson(sloppy)).toBe(renderAuditJson(sloppy));
	});

	test("anchors determinism on the measurement payload, not run metadata", () => {
		const sloppy = report("sloppy");
		const later: AuditReport = {
			...sloppy,
			run: { auditedAt: "2026-06-01T00:00:00.000Z", durationMs: 999 },
		};
		const first = JSON.parse(renderAuditJson(sloppy));
		const second = JSON.parse(renderAuditJson(later));
		expect(measurementPayload(second)).toEqual(measurementPayload(first));
	});

	test("refuses to publish a report that violates the §6.4 honesty invariants", () => {
		const incomplete = report("incomplete");
		// Flipping completeness to "complete" breaks the metric-state rollup invariant.
		const tampered: AuditReport = {
			...incomplete,
			completeness: "complete",
			score: { ...incomplete.score, partial: false },
		};
		expect(() => renderAuditJson(tampered)).toThrow();
	});

	test("keeps the score's direction and scoring version in the machine document", () => {
		for (const kind of FIXTURE_KINDS) {
			const parsed = JSON.parse(renderAuditJson(report(kind))) as AuditReport;
			expect(parsed.score.direction).toBe("lower-is-better");
			expect(parsed.scoringVersion).toBe(report(kind).scoringVersion);
		}
	});
});
