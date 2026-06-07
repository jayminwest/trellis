/**
 * Exit-code assessment (SPEC §12) — the surface-agnostic core of the
 * `--fail-on` contract. Given a scored {@link Report} (+ the rubric, to know
 * which criteria are gates) and a {@link FailPolicy}, decide whether the run
 * should trip a non-zero exit and why. The CLI maps a tripped assessment to a
 * process exit code; the SDK re-exports this so a script driving trellis
 * in-process applies the identical rule — one code path (SPEC §13.1).
 *
 * The default (no `--fail-on`) fails on **gate OR drift** (SPEC §12); a single
 * `--fail-on` value narrows the assessment to one dimension, and `none` disables
 * it. `level` compares `report.level` against {@link FailPolicy.minLevel}
 * (default {@link DEFAULT_MIN_LEVEL}).
 */
import type { Level, Rubric } from "../rubric/index.ts";
import { gateFails } from "../scoring/index.ts";
import { failingDriftCount, hasFailingDrift } from "../standards/index.ts";
import type { Report } from "./types.ts";

/** The tunable `--fail-on` values (SPEC §12). Omitting the flag is the default (gate ∨ drift). */
export const FAIL_ON_MODES = ["level", "gate", "drift", "none"] as const;
export type FailOnMode = (typeof FAIL_ON_MODES)[number];

/** Default `--min-level` threshold for `--fail-on level` when none is supplied. */
export const DEFAULT_MIN_LEVEL: Level = 3;

/** A resolved `--fail-on` policy. `mode` absent ⇒ the default (gate ∨ drift). */
export interface FailPolicy {
	/** The `--fail-on` dimension; absent selects the gate-or-drift default. */
	mode?: FailOnMode;
	/** Threshold for `--fail-on level`; defaults to {@link DEFAULT_MIN_LEVEL}. */
	minLevel?: Level;
}

/** Whether a run trips a non-zero exit, with the human reasons it did. */
export interface Assessment {
	failed: boolean;
	reasons: string[];
}

/** Which dimensions a `--fail-on` mode checks; the default checks gate ∨ drift. */
export function activeChecks(mode: FailOnMode | undefined): {
	gate: boolean;
	drift: boolean;
	level: boolean;
} {
	switch (mode) {
		case "none":
			return { gate: false, drift: false, level: false };
		case "gate":
			return { gate: true, drift: false, level: false };
		case "drift":
			return { gate: false, drift: true, level: false };
		case "level":
			return { gate: false, drift: false, level: true };
		default:
			return { gate: true, drift: true, level: false };
	}
}

/** Ids of gate criteria that were measured and did not fully pass (SPEC §3.3). */
export function failingGateIds(report: Report, rubric: Rubric): string[] {
	const ids: string[] = [];
	for (const criterion of rubric.criteria) {
		if (criterion.gate && gateFails(report.criteria[criterion.id])) ids.push(criterion.id);
	}
	return ids;
}

/**
 * Assess a single-repo {@link Report} against a {@link FailPolicy}. `none` (or a
 * policy whose checks are all off) is always clean; otherwise each active
 * dimension contributes a reason when it trips, and `failed` is true iff any did.
 */
export function assessReport(report: Report, rubric: Rubric, policy: FailPolicy = {}): Assessment {
	const checks = activeChecks(policy.mode);
	const reasons: string[] = [];
	if (checks.gate) {
		const gates = failingGateIds(report, rubric);
		if (gates.length > 0) reasons.push(`gate criterion failed: ${gates.join(", ")}`);
	}
	if (checks.drift && report.drift && hasFailingDrift(report.drift.summary)) {
		reasons.push(`canonical drift detected (${failingDriftCount(report.drift.summary)} files)`);
	}
	if (checks.level) {
		const min = policy.minLevel ?? DEFAULT_MIN_LEVEL;
		if (report.level < min) reasons.push(`level L${report.level} below minimum L${min}`);
	}
	return { failed: reasons.length > 0, reasons };
}
