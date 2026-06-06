/**
 * Render-time folds over a {@link Report} (SPEC §6.3) — the per-category rollup
 * and the whole-run N/A tally the terminal and markdown renderers share. Both
 * are pure projections of the report's `criteria` plus the rubric's category
 * membership; keeping them here (not duplicated per renderer) is what lets the
 * terminal table and the markdown scorecard agree number-for-number.
 *
 * The report's `criteria` carries no category, so these folds take the loaded
 * {@link Rubric} for membership — the same rubric the audit scored against.
 */
import type { Rubric } from "../rubric/index.ts";
import { disposition, perCriterionScore, type ScorecardEntry } from "../scoring/index.ts";
import type { Report } from "./types.ts";

/** Per-category scoring rollup, in `categories.yaml` order. */
export interface CategoryRollup {
	id: string;
	title: string;
	/** Criteria in this category (the rubric universe for the category). */
	total: number;
	/** Criteria with a real measurement (feed the category pass-rate). */
	counted: number;
	/** Sum of per-criterion scores over `counted` — `passRate = passSum / counted`. */
	passSum: number;
	/** Should-have-measured-but-didn't (counts against coverage, SPEC §3.2). */
	noDetector: number;
	/** Honestly absent (excluded from coverage, SPEC §3.2). */
	notApplicable: number;
	/** In the rubric but absent from the report (shouldn't occur in a full audit). */
	skipped: number;
	/** Mean per-criterion score over counted criteria, or `0` when none counted. */
	passRate: number;
}

/** Whole-run disposition tally (the N/A breakdown the banner prints). */
export interface Tally {
	total: number;
	counted: number;
	noDetector: number;
	notApplicable: number;
	skipped: number;
}

/** Fold one entry's contribution into a mutable accumulator. */
function accumulate(
	acc: { counted: number; passSum: number; noDetector: number; notApplicable: number },
	entry: ScorecardEntry,
): void {
	switch (disposition(entry)) {
		case "counted":
			acc.counted += 1;
			acc.passSum += perCriterionScore(entry) ?? 0;
			break;
		case "no-detector":
			acc.noDetector += 1;
			break;
		case "not-applicable":
			acc.notApplicable += 1;
			break;
	}
}

/** Roll a report up by category, in rubric (`categories.yaml`) order. */
export function rollupByCategory(report: Report, rubric: Rubric): CategoryRollup[] {
	const byCategory = new Map<string, string[]>();
	for (const criterion of rubric.criteria) {
		const bucket = byCategory.get(criterion.category) ?? [];
		bucket.push(criterion.id);
		byCategory.set(criterion.category, bucket);
	}

	return rubric.categories.map((category): CategoryRollup => {
		const ids = byCategory.get(category.id) ?? [];
		const acc = { counted: 0, passSum: 0, noDetector: 0, notApplicable: 0 };
		let skipped = 0;
		for (const id of ids) {
			const entry = report.criteria[id];
			if (entry === undefined) {
				skipped += 1;
				continue;
			}
			accumulate(acc, entry);
		}
		return {
			id: category.id,
			title: category.title,
			total: ids.length,
			counted: acc.counted,
			passSum: acc.passSum,
			noDetector: acc.noDetector,
			notApplicable: acc.notApplicable,
			skipped,
			passRate: acc.counted === 0 ? 0 : acc.passSum / acc.counted,
		};
	});
}

/** Tally the whole run's dispositions for the N/A breakdown banner. */
export function tally(report: Report): Tally {
	const acc = { counted: 0, passSum: 0, noDetector: 0, notApplicable: 0 };
	const ids = Object.keys(report.criteria);
	for (const id of ids) {
		const entry = report.criteria[id];
		if (entry !== undefined) accumulate(acc, entry);
	}
	return {
		total: ids.length,
		counted: acc.counted,
		noDetector: acc.noDetector,
		notApplicable: acc.notApplicable,
		skipped: 0,
	};
}

/** Format a `[0,1]` fraction as a whole-number percent (`0.571 → "57%"`). */
export function pct(fraction: number): string {
	return `${Math.round(fraction * 100)}%`;
}
