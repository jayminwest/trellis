/**
 * Structural erosion math (SPEC §5.2) — pure functions, no AST.
 *
 * Erosion weights complexity by size so a huge tangled function outranks a
 * tiny tangled one:
 *
 * - **Function mass** = `CC × sqrt(SLOC)`.
 * - **Eroded mass** = the mass of functions with `CC > EROSION_CC_THRESHOLD`
 *   (threshold 10, SPEC §5.2 "CC > 10" — strictly greater).
 * - **Eroded mass share** = `Σ eroded mass / Σ mass` over a scope; `null`
 *   when the scope has no mass (a 0/0 ratio is `not-applicable`, never 0).
 *
 * Aggregation from functions → packages → repo scope **sums masses**; a
 * scope's share is computed from the summed masses, never by averaging
 * package shares (a big package's erosion must not be diluted by tiny ones).
 */
import type { CcDistribution, MassAggregate, PackageAggregate } from "./types.ts";
import { EROSION_CC_THRESHOLD } from "./types.ts";

/** Function mass: `CC × sqrt(SLOC)` (SPEC §5.2). */
export function functionMass(cc: number, sloc: number): number {
	return cc * Math.sqrt(sloc);
}

/** True when `cc` exceeds the erosion threshold (strictly greater than 10). */
export function isEroded(cc: number): boolean {
	return cc > EROSION_CC_THRESHOLD;
}

/**
 * Deterministic decimal rounding for emitted values (3 decimals for masses,
 * 6 for ratios), so reported numbers are stable and hand-checkable. Ranking
 * always uses the unrounded values.
 */
export function roundTo(value: number, decimals: number): number {
	const factor = 10 ** decimals;
	return Math.round(value * factor) / factor;
}

/**
 * Nearest-rank percentile of an ascending-sorted sample: `p50` of
 * `[1,2,3,4]` is the value at rank `ceil(0.5 × 4) = 2`, i.e. `2`. Returns
 * `null` for an empty sample (documented not-applicable state, SPEC §5.1).
 */
export function nearestRank(sortedAsc: readonly number[], percentile: number): number | null {
	const n = sortedAsc.length;
	if (n === 0) return null;
	const rank = Math.max(1, Math.ceil((percentile / 100) * n));
	return sortedAsc[rank - 1] ?? null;
}

/** The p50/p90/max distribution of a CC sample; `null` when empty. */
export function ccDistribution(ccValues: readonly number[]): CcDistribution | null {
	if (ccValues.length === 0) return null;
	const sorted = [...ccValues].sort((a, b) => a - b);
	const p50 = nearestRank(sorted, 50);
	const p90 = nearestRank(sorted, 90);
	const max = sorted[sorted.length - 1];
	if (p50 === null || p90 === null || max === undefined) return null;
	return { p50, p90, max };
}

/** One function's contribution to a mass aggregate. */
export interface MassContribution {
	mass: number;
	eroded: boolean;
}

/**
 * Sum masses into a {@link MassAggregate} (see the module docblock: summed
 * masses, share from the sums — never averaged percentages).
 */
export function aggregateMass(
	files: number,
	sloc: number,
	contributions: readonly MassContribution[],
): MassAggregate {
	let mass = 0;
	let erodedMass = 0;
	let erodedCount = 0;
	for (const contribution of contributions) {
		mass += contribution.mass;
		if (contribution.eroded) {
			erodedMass += contribution.mass;
			erodedCount += 1;
		}
	}
	return {
		files,
		sloc,
		functionCount: contributions.length,
		mass,
		erodedMass,
		erodedCount,
		erodedShare: mass === 0 ? null : erodedMass / mass,
	};
}

/**
 * Sum function-level aggregates into one package aggregate. Package
 * `sloc`/`files` come from file-level counts, so overlapping function
 * ranges never inflate them.
 */
export function packageAggregate(
	packagePath: string,
	files: number,
	sloc: number,
	contributions: readonly MassContribution[],
): PackageAggregate {
	return { packagePath, ...aggregateMass(files, sloc, contributions) };
}
