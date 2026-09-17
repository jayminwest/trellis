import { describe, expect, test } from "bun:test";
import type { PolicyAssessment } from "../compare/index.ts";
import type { AuditReport } from "../contract/index.ts";
import { assessFleet } from "./assess.ts";
import type { FleetEntry, FleetReport } from "./orchestrate.ts";

/** Build a fleet report from raw entries. */
function fleet(entries: FleetEntry[]): FleetReport {
	return {
		auditedAt: "2026-06-06T00:00:00.000Z",
		entries,
		summary: {
			ok: entries.filter((e) => e.ok).length,
			error: entries.filter((e) => !e.ok).length,
			policyFailed: entries.filter((e) => e.ok && e.policy.failed).length,
		},
	};
}

/** A minimal scored entry; only the fields the assessment reads are real. */
function ok(id: string, policy: PolicyAssessment = { failed: false, results: [] }): FleetEntry {
	return {
		id,
		path: `/abs/${id}`,
		ok: true,
		report: { score: { index: 12 } } as unknown as AuditReport,
		policy,
		drift: { match: 0, "allowed-delta": 0, drift: 3, missing: 1, extra: 0 },
		driftError: null,
		previousIndex: null,
		indexDelta: null,
	};
}

/** A tripped max-index policy assessment. */
const TRIPPED: PolicyAssessment = {
	failed: true,
	results: [
		{
			policy: "max-index",
			status: "fail",
			reasons: [
				{
					code: "index-exceeds-max",
					message: "sloppiness index 12 exceeds the configured maximum 0",
				},
			],
		},
	],
};

const ERR: FleetEntry = { id: "gone", path: "/abs/gone", ok: false, error: "path not found" };

describe("assessFleet", () => {
	test("a clean fleet does not fail", () => {
		expect(assessFleet(fleet([ok("a"), ok("b")]))).toEqual({ failed: false, reasons: [] });
	});

	test("an errored target fails with its error as the reason", () => {
		const a = assessFleet(fleet([ok("a"), ERR]));
		expect(a.failed).toBe(true);
		expect(a.reasons.join(" ")).toContain("gone: path not found");
	});

	test("a target's tripped declarative policy fails with the policy reasons", () => {
		const a = assessFleet(fleet([ok("a", TRIPPED), ok("b")]));
		expect(a.failed).toBe(true);
		expect(a.reasons).toHaveLength(1);
		expect(a.reasons[0]).toContain("a: policy failed");
		expect(a.reasons[0]).toContain("sloppiness index 12 exceeds the configured maximum 0");
		expect(a.reasons.join(" ")).not.toContain("b:");
	});

	test("canonical drift never gates the fleet (a separate, non-scoring capability)", () => {
		// The ok() entries above carry failing drift states; the fleet stays clean.
		expect(assessFleet(fleet([ok("a")])).failed).toBe(false);
	});
});
