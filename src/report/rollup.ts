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
import {
	disposition,
	gateFails,
	type NaKind,
	perCriterionScore,
	type ScorecardEntry,
} from "../scoring/index.ts";
import { criterionStatus } from "./changes.ts";
import type { CriterionStatus, Report } from "./types.ts";

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

/**
 * One criterion's fully-projected line for the detailed (file) report — the
 * §6.2 entry joined to its rubric metadata (category, gate flag) and folded to a
 * single {@link CriterionStatus} verdict. The markdown FILE renderer lists these
 * grouped by category; the brief terminal view never uses them.
 */
export interface CriterionLine {
	id: string;
	category: string;
	status: CriterionStatus;
	numerator: number | null;
	denominator: number;
	rationale: string;
	naKind: NaKind | null;
	/** Whether this criterion is its category's gate (SPEC §3.3). */
	gate: boolean;
	/** Whether this gate criterion was measured and did not fully pass. */
	gateFailed: boolean;
}

/** A category's criteria lines, ordered with the most actionable verdicts first. */
export interface CategoryCriteria {
	id: string;
	title: string;
	lines: CriterionLine[];
}

/** Surface priority within a category — actionable (failing/gap) verdicts first. */
const STATUS_ORDER: Record<CriterionStatus, number> = {
	fail: 0,
	partial: 1,
	"no-detector": 2,
	pass: 3,
	"not-applicable": 4,
};

/**
 * Project every measured criterion into a per-category, failing-first list for
 * the detailed report. Walks the rubric (for category membership + gate flags),
 * folds each §6.2 entry to a {@link CriterionLine}, then stable-sorts each
 * category by {@link STATUS_ORDER} so failing criteria surface first while
 * equal-verdict criteria keep rubric order.
 */
export function projectCriteria(report: Report, rubric: Rubric): CategoryCriteria[] {
	const byCategory = new Map<string, CriterionLine[]>();
	for (const criterion of rubric.criteria) {
		const entry = report.criteria[criterion.id];
		if (entry === undefined) continue;
		const line: CriterionLine = {
			id: criterion.id,
			category: criterion.category,
			status: criterionStatus(entry),
			numerator: entry.numerator,
			denominator: entry.denominator,
			rationale: entry.rationale,
			naKind: entry.naKind ?? null,
			gate: criterion.gate,
			gateFailed: criterion.gate && gateFails(entry),
		};
		const bucket = byCategory.get(criterion.category) ?? [];
		bucket.push(line);
		byCategory.set(criterion.category, bucket);
	}

	return rubric.categories.map((category): CategoryCriteria => {
		const lines = byCategory.get(category.id) ?? [];
		const sorted = lines
			.map((line, index) => ({ line, index }))
			.sort(
				(a, b) => STATUS_ORDER[a.line.status] - STATUS_ORDER[b.line.status] || a.index - b.index,
			)
			.map((x) => x.line);
		return { id: category.id, title: category.title, lines: sorted };
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
