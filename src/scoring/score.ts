/**
 * The v0 scorer (SPEC §3.4) — pure, equal-weighted, no I/O.
 *
 * Folds a run's §6.2 scorecard over the rubric's criterion universe into a
 * pass-rate, a coverage fraction, and the coverage-clamped maturity level.
 * `gate`/`weight` are reserved and deliberately not consulted here (SPEC §3.3).
 */
import type { Level } from "../rubric/index.ts";
import { band, clampLevel } from "./band.ts";
import { disposition, perCriterionScore, type ScorecardEntry } from "./entry.ts";

/** How the rubric universe split across dispositions for one run. */
export interface ScoreCounts {
	/** Size of the scored universe (`= counted + noDetector + notApplicable + skipped`). */
	total: number;
	/** Criteria with a real measurement (feed pass-rate + coverage). */
	counted: number;
	/** Should-have-measured-but-didn't; counted against coverage (SPEC §3.2). */
	noDetector: number;
	/** Honestly absent; excluded from the coverage base (SPEC §3.2). */
	notApplicable: number;
	/** In the rubric but absent from the scorecard; counted against coverage. */
	skipped: number;
}

/** The whole-run score (SPEC §3.4, feeds the §6.3 report's `level`/`passRate`/`coverage`). */
export interface Scorecard {
	level: Level;
	passRate: number;
	coverage: number;
	passRateLevel: Level;
	coverageLevel: Level;
	counts: ScoreCounts;
}

/**
 * Score a run. `criterionIds` is the rubric universe (authoritative — entries
 * for ids outside it are ignored); `entries` is the run's §6.2 scorecard. Ids in
 * the universe with no entry are `skipped` and drag coverage down.
 *
 * ```
 * passRate = mean(numerator/denominator over counted criteria)   # N/A excluded
 * coverage = counted / (counted + noDetector + skipped)          # not-applicable excluded
 * level    = min(band(passRate), band(coverage))                 # monotonic clamp
 * ```
 */
export function scoreRun(
	criterionIds: readonly string[],
	entries: ReadonlyMap<string, ScorecardEntry>,
): Scorecard {
	let counted = 0;
	let noDetector = 0;
	let notApplicable = 0;
	let skipped = 0;
	let scoreSum = 0;

	for (const id of criterionIds) {
		const entry = entries.get(id);
		if (entry === undefined) {
			skipped += 1;
			continue;
		}
		switch (disposition(entry)) {
			case "counted": {
				counted += 1;
				// perCriterionScore is non-null for counted entries.
				scoreSum += perCriterionScore(entry) ?? 0;
				break;
			}
			case "no-detector":
				noDetector += 1;
				break;
			case "not-applicable":
				notApplicable += 1;
				break;
		}
	}

	const passRate = counted === 0 ? 0 : scoreSum / counted;
	const coverageBase = counted + noDetector + skipped;
	const coverage = coverageBase === 0 ? 0 : counted / coverageBase;
	const passRateLevel = band(passRate);
	const coverageLevel = band(coverage);

	return {
		level: clampLevel(passRateLevel, coverageLevel),
		passRate,
		coverage,
		passRateLevel,
		coverageLevel,
		counts: {
			total: criterionIds.length,
			counted,
			noDetector,
			notApplicable,
			skipped,
		},
	};
}
