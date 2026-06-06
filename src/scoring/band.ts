/**
 * Band & clamp math (SPEC §3.4) — the surface-agnostic core's pure leveling
 * primitives. A fraction in `[0, 1]` maps to a maturity {@link Level} via fixed
 * 20-pt bands; the coverage-aware clamp takes the lower of two levels.
 */
import type { Level } from "../rubric/index.ts";

/**
 * Map a fraction to a 20-pt maturity band (SPEC §3.4):
 * L1 0–20%, L2 20–40%, L3 40–60%, L4 60–80%, L5 80–100%.
 *
 * Bands are lower-bound inclusive / upper-bound exclusive (L5 caps at 100%), so
 * a boundary value belongs to the higher band: `band(0.2) === 2`,
 * `band(0.6) === 4`, `band(0.8) === 5`. The `!(x >= 0.2)` form also folds `NaN`
 * to the floor rather than silently banding it high.
 */
export function band(fraction: number): Level {
	if (!(fraction >= 0.2)) return 1;
	if (fraction < 0.4) return 2;
	if (fraction < 0.6) return 3;
	if (fraction < 0.8) return 4;
	return 5;
}

/**
 * The coverage-aware clamp (SPEC §3.4): the repo level is the lower of its
 * pass-rate band and its coverage band. The clamp is **monotonic — it only ever
 * lowers a level**; at full coverage `coverageLevel` is 5 and the clamp is a
 * no-op.
 */
export function clampLevel(passRateLevel: Level, coverageLevel: Level): Level {
	return passRateLevel < coverageLevel ? passRateLevel : coverageLevel;
}
