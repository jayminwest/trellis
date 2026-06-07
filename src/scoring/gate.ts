/**
 * Gate evaluation (SPEC §3.3, §12). Each category has exactly one `gate: true`
 * floor criterion; the v0 scorer leaves it reserved, but the `--fail-on gate`
 * exit-code contract (SPEC §12) is the first place gates are *read*.
 *
 * A gate is treated as **failing only when it was actually measured and did not
 * fully pass** — an N/A gate (`no-detector` or `not-applicable`) cannot fail a
 * build, since trellis never measured the floor it would gate on. This keeps a
 * coverage gap from masquerading as a policy failure.
 */
import { disposition, perCriterionScore, type ScorecardEntry } from "./entry.ts";

/**
 * True when `entry` is a measured gate criterion that did not fully pass
 * (per-criterion score `< 1`). A missing entry or an N/A entry never fails.
 */
export function gateFails(entry: ScorecardEntry | undefined): boolean {
	if (entry === undefined) return false;
	if (disposition(entry) !== "counted") return false;
	return (perCriterionScore(entry) ?? 0) < 1;
}
