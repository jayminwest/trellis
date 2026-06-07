/**
 * Fleet exit-code assessment (SPEC §12) — the multi-repo analogue of
 * {@link assessReport}. A {@link FleetReport} carries only aggregate per-target
 * metrics (level, drift counts, gate-failure count), so the assessment works off
 * those rather than per-criterion data. Any target that failed to audit trips a
 * non-zero exit under any active policy — an unauditable repo is a CI failure —
 * while `none` is always clean.
 */
import {
	type Assessment,
	activeChecks,
	DEFAULT_MIN_LEVEL,
	type FailPolicy,
} from "../report/index.ts";
import { hasFailingDrift } from "../standards/index.ts";
import type { FleetReport } from "./orchestrate.ts";

/**
 * Assess a {@link FleetReport} against a {@link FailPolicy}. With every check off
 * (`--fail-on none`) the fleet is always clean; otherwise each errored target
 * fails, and each scored target contributes a reason per tripped dimension.
 */
export function assessFleet(report: FleetReport, policy: FailPolicy = {}): Assessment {
	const checks = activeChecks(policy.mode);
	if (!checks.gate && !checks.drift && !checks.level) return { failed: false, reasons: [] };
	const min = policy.minLevel ?? DEFAULT_MIN_LEVEL;
	const reasons: string[] = [];
	for (const entry of report.entries) {
		if (!entry.ok) {
			reasons.push(`${entry.id}: ${entry.error}`);
			continue;
		}
		if (checks.gate && entry.gateFailures > 0) {
			reasons.push(`${entry.id}: ${entry.gateFailures} gate criterion failure(s)`);
		}
		if (checks.drift && entry.drift && hasFailingDrift(entry.drift)) {
			reasons.push(`${entry.id}: canonical drift detected`);
		}
		if (checks.level && entry.level < min) {
			reasons.push(`${entry.id}: level L${entry.level} below minimum L${min}`);
		}
	}
	return { failed: reasons.length > 0, reasons };
}
