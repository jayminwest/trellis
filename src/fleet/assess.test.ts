import { describe, expect, test } from "bun:test";
import type { DriftState } from "../standards/index.ts";
import { assessFleet } from "./assess.ts";
import type { FleetEntry, FleetReport } from "./orchestrate.ts";

/** Zeroed per-state drift counts, optionally overridden. */
function drift(over: Partial<Record<DriftState, number>> = {}): Record<DriftState, number> {
	return { match: 0, "allowed-delta": 0, drift: 0, missing: 0, extra: 0, ...over };
}

/** Build a fleet report from raw entries. */
function fleet(entries: FleetEntry[]): FleetReport {
	return {
		scoredAt: "2026-06-06T00:00:00.000Z",
		rubricVersion: "0.1.0",
		canonicalVersion: "1.0.0",
		entries,
		summary: { ok: entries.filter((e) => e.ok).length, error: entries.filter((e) => !e.ok).length },
	};
}

/** A scored target entry with sensible defaults. */
function ok(id: string, over: Partial<Extract<FleetEntry, { ok: true }>> = {}): FleetEntry {
	return {
		id,
		path: `/abs/${id}`,
		ok: true,
		level: 4,
		passRate: 0.8,
		coverage: 1,
		drift: drift(),
		gateFailures: 0,
		previousLevel: null,
		levelDelta: null,
		...over,
	};
}

const ERR: FleetEntry = { id: "gone", path: "/abs/gone", ok: false, error: "path not found" };

describe("assessFleet", () => {
	test("a clean fleet does not fail under the default policy", () => {
		expect(assessFleet(fleet([ok("a"), ok("b")])).failed).toBe(false);
	});

	test("an errored target fails under any active policy", () => {
		const a = assessFleet(fleet([ok("a"), ERR]));
		expect(a.failed).toBe(true);
		expect(a.reasons.join(" ")).toContain("gone: path not found");
	});

	test("none is always clean, even with errors and gate failures", () => {
		const report = fleet([ok("a", { gateFailures: 3 }), ERR]);
		expect(assessFleet(report, { mode: "none" })).toEqual({ failed: false, reasons: [] });
	});

	test("default trips on a target's gate failures", () => {
		const a = assessFleet(fleet([ok("a", { gateFailures: 2 })]));
		expect(a.failed).toBe(true);
		expect(a.reasons[0]).toContain("a: 2 gate criterion failure(s)");
	});

	test("default trips on a target's canonical drift", () => {
		const a = assessFleet(fleet([ok("a", { drift: drift({ missing: 1 }) })]));
		expect(a.failed).toBe(true);
		expect(a.reasons[0]).toContain("a: canonical drift detected");
	});

	test("level mode compares each target against the threshold", () => {
		const report = fleet([ok("a", { level: 2 }), ok("b", { level: 5 })]);
		const a = assessFleet(report, { mode: "level", minLevel: 3 });
		expect(a.failed).toBe(true);
		expect(a.reasons.join(" ")).toContain("a: level L2 below minimum L3");
		expect(a.reasons.join(" ")).not.toContain("b:");
	});

	test("gate mode ignores drift", () => {
		const report = fleet([ok("a", { drift: drift({ drift: 1 }), gateFailures: 0 })]);
		expect(assessFleet(report, { mode: "gate" }).failed).toBe(false);
	});
});
