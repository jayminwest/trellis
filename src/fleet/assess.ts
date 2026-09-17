/**
 * Fleet exit-code assessment (SPEC §9, §11, trellis-8366) — the multi-repo
 * analogue of the declarative policy gate. There are no fleet-level scoring
 * knobs: each target already carries the §9 {@link PolicyAssessment} over its
 * own `trellis.yaml` policy block, so the fleet fails exactly when a target
 * could not audit (an unauditable repo is a CI failure) or a target's
 * declarative policy tripped. Canonical drift, a separate capability, never
 * gates here — it has no policy dimension and cannot change the structural
 * score (SPEC §11).
 */
import type { FleetReport } from "./orchestrate.ts";

/** The fleet-level pass/fail rollup: `failed` plus one human reason per tripped target. */
export interface FleetAssessment {
	readonly failed: boolean;
	readonly reasons: readonly string[];
}

/**
 * Assess a {@link FleetReport} for the exit-code contract: `failed` iff any
 * target errored or any target's policy assessment failed. Reasons name the
 * target and the tripped policy codes so CI logs are actionable.
 */
export function assessFleet(report: FleetReport): FleetAssessment {
	const reasons: string[] = [];
	for (const entry of report.entries) {
		if (!entry.ok) {
			reasons.push(`${entry.id}: ${entry.error}`);
			continue;
		}
		if (entry.policy.failed) {
			const codes = entry.policy.results
				.filter((r) => r.status === "fail")
				.flatMap((r) => r.reasons.map((reason) => reason.message));
			reasons.push(`${entry.id}: policy failed — ${codes.join("; ")}`);
		}
	}
	return { failed: reasons.length > 0, reasons };
}
