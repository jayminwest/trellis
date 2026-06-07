/**
 * Drift-state vocabulary (SPEC §10) and the `--fail-on drift` predicates (SPEC
 * §12). Split from `drift.ts` so the state enum and the failing-state helpers —
 * shared by the engine, the renderers, the fleet, and the exit-code assessment —
 * live in one small, dependency-free module.
 */

/** Per-file drift outcome (SPEC §10). `drift`/`missing` fail; the rest are clean. */
export const DRIFT_STATES = ["match", "allowed-delta", "drift", "missing", "extra"] as const;
export type DriftState = (typeof DRIFT_STATES)[number];

/** The drift states that mean the target has fallen out of canonical sync. */
export const FAILING_DRIFT_STATES = ["drift", "missing"] as const;

/**
 * True when a per-state drift summary counts any {@link FAILING_DRIFT_STATES}
 * file — the `--fail-on drift` predicate (SPEC §12). Takes the summary (not the
 * whole report) so a drift report and a fleet entry's drift counts share one rule.
 */
export function hasFailingDrift(summary: Record<DriftState, number>): boolean {
	return FAILING_DRIFT_STATES.some((state) => summary[state] > 0);
}

/** Count of files in a failing drift state (`drift` + `missing`), for messages. */
export function failingDriftCount(summary: Record<DriftState, number>): number {
	return FAILING_DRIFT_STATES.reduce((sum, state) => sum + summary[state], 0);
}
