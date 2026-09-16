/**
 * The provisional sloppiness formula (SPEC §7, trellis-00d5) — versioned
 * constants and pure math helpers.
 *
 * `SCORING_FORMULA` pins every normalization threshold, term share, and
 * dimension weight under {@link SCORING_VERSION} (`0.1.0-provisional`).
 * The formula is **provisional** pending calibration against the fixed
 * corpus (SPEC §14); any recalibration bumps the scoring version and its
 * test expectations together. The formula takes **no configuration input**:
 * policy budgets (SPEC §6.5) gate pass/fail and can never mutate these
 * weights, and the strict audit-config schema rejects scoring keys
 * outright.
 *
 * Fixed formula rules (SPEC §7):
 *
 * - The index scores the **production** source set only; test-set metrics
 *   are reported raw and never offset production debt (§3.1, §3.4).
 * - Overlapping signals (complexity, erosion, size) are grouped into one
 *   `complexity-erosion` dimension so the same underlying tangle is never
 *   penalized multiple times.
 * - Each term normalizes linearly to 0–100 against a documented
 *   **saturation** threshold (`100 × min(1, value / saturation)`), and each
 *   dimension blends an absolute-count term beside its density term, so
 *   large clean additions can never dilute counts or erase hotspot weight
 *   (§3.4 "counts and densities are both retained").
 * - Every term is non-decreasing in its raw metric and every weight is
 *   positive, so the index is monotonic: no code change that worsens a raw
 *   metric may improve the index.
 *
 * Arithmetic is IEEE-754 double; rounding is `roundHalfUp(x) = ⌊x + 0.5⌋`,
 * deterministic across runs and platforms ("stable rounding").
 */
import { SCORING_VERSION } from "../contract/index.ts";

/** One scored term: a raw metric, the value at which it saturates to 100, and its blend share. */
export interface FormulaTerm {
	/** Contract metric id consumed by this term (SPEC §6.1). */
	metricId: string;
	/** Raw value at which the term saturates to 100 normalized points. */
	saturatesAt: number;
	/** Share of this term within its dimension; shares sum to 1 per dimension. */
	share: number;
}

/** One grouped dimension of the index. */
export interface FormulaDimension {
	/** Dotted dimension id (e.g. `complexity-erosion`). */
	dimension: string;
	/** Weight of the dimension in the index; weights sum to 1. */
	weight: number;
	terms: FormulaTerm[];
}

/** The versioned formula definition. */
export interface ScoringFormula {
	/** The scoring version these constants are pinned under (SPEC §3.5). */
	version: string;
	/** True while the formula awaits corpus calibration (SPEC §14). */
	provisional: true;
	dimensions: FormulaDimension[];
}

/**
 * The provisional formula constants (SPEC §7.1). Changing any number here
 * is a recalibration: bump {@link SCORING_VERSION} and the test
 * expectations in the same change.
 */
export const SCORING_FORMULA: ScoringFormula = {
	version: SCORING_VERSION,
	provisional: true,
	dimensions: [
		{
			dimension: "complexity-erosion",
			weight: 0.5,
			terms: [
				{ metricId: "erosion.eroded-count.production", saturatesAt: 20, share: 0.5 },
				{ metricId: "erosion.eroded-share.production", saturatesAt: 0.25, share: 0.5 },
			],
		},
		{
			dimension: "duplication",
			weight: 0.3,
			terms: [
				{ metricId: "duplication.density.production", saturatesAt: 0.15, share: 0.5 },
				{ metricId: "duplication.groups.production", saturatesAt: 15, share: 0.5 },
			],
		},
		{
			dimension: "import-cycle",
			weight: 0.2,
			terms: [
				{ metricId: "import-cycle.density", saturatesAt: 0.1, share: 0.5 },
				{ metricId: "import-cycle.groups", saturatesAt: 5, share: 0.5 },
			],
		},
	],
};

/** Clamp to the unit interval. */
export function clamp01(value: number): number {
	if (value <= 0) return 0;
	if (value >= 1) return 1;
	return value;
}

/** Normalize a raw metric to 0–100 points: linear up to `saturatesAt`, clamped beyond. */
export function normalizeTerm(value: number, saturatesAt: number): number {
	return clamp01(value / saturatesAt) * 100;
}

/** Stable rounding: `⌊x + 0.5⌋` (round half up) over IEEE-754 doubles. */
export function roundHalfUp(value: number): number {
	return Math.floor(value + 0.5);
}

/** One exact (unrounded) share of a total to apportion. */
export interface ApportionPart {
	key: string;
	exact: number;
}

/**
 * Largest-remainder apportionment: round `total` with {@link roundHalfUp},
 * floor every part, then hand the remaining points to the largest
 * fractional parts (ties by `key` ascending, so the result is deterministic
 * regardless of input order). The returned integers sum **exactly** to the
 * rounded total — reported contributions always add up to the index.
 */
export function apportionPoints(
	total: number,
	parts: readonly ApportionPart[],
): Map<string, number> {
	const target = roundHalfUp(total);
	const floored = parts.reduce((sum, part) => sum + Math.floor(part.exact), 0);
	const byFraction = [...parts].sort((a, b) => {
		const fractionA = a.exact - Math.floor(a.exact);
		const fractionB = b.exact - Math.floor(b.exact);
		if (fractionA !== fractionB) return fractionB - fractionA;
		return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
	});
	const apportioned = new Map(parts.map((part) => [part.key, Math.floor(part.exact)]));
	let left = Math.max(0, target - floored);
	for (const part of byFraction) {
		if (left <= 0) break;
		apportioned.set(part.key, (apportioned.get(part.key) ?? 0) + 1);
		left -= 1;
	}
	return apportioned;
}
