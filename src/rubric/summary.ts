/**
 * Rubric summary (core, surface-agnostic — SPEC §13.1).
 *
 * Folds a loaded {@link Rubric} into a compact, render-ready shape: per-category
 * criterion counts (with the repo/app split and the level histogram) plus the
 * gate criterion id for each category, and the rubric-wide totals. The CLI's
 * `trellis rubric` command renders this; it computes nothing itself. Keeping the
 * fold here (not in `cli/`) is what lets the SDK and CLI report identically.
 */
import type { Rubric } from "./loader.ts";
import type { CriterionRecord } from "./schema.ts";
import { RUBRIC_VERSION } from "./version.ts";

/** Maturity levels a criterion can carry (SPEC §3). */
export const LEVELS = [1, 2, 3, 4, 5] as const;
export type Level = (typeof LEVELS)[number];

/** A count of criteria keyed by maturity level (every level present, zero-filled). */
export type LevelHistogram = Record<Level, number>;

/** Per-category rollup: counts, repo/app split, level histogram, gate id. */
export interface CategorySummary {
	id: string;
	title: string;
	criterionCount: number;
	repo: number;
	app: number;
	levels: LevelHistogram;
	/** The single gate:true criterion id for this category (invariant 5). */
	gate: string | null;
}

/** The whole-rubric summary the `rubric` command prints. */
export interface RubricSummary {
	rubricVersion: string;
	categoryCount: number;
	criterionCount: number;
	categories: CategorySummary[];
}

/** Build a fresh zero-filled level histogram. */
function emptyHistogram(): LevelHistogram {
	return { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
}

/**
 * Summarize a loaded rubric. Categories appear in `categories.yaml` order;
 * within each, the level histogram covers every criterion regardless of scope.
 */
export function summarizeRubric(rubric: Rubric): RubricSummary {
	const byCategory = new Map<string, CriterionRecord[]>();
	for (const criterion of rubric.criteria) {
		const bucket = byCategory.get(criterion.category) ?? [];
		bucket.push(criterion);
		byCategory.set(criterion.category, bucket);
	}

	const categories = rubric.categories.map((category): CategorySummary => {
		const members = byCategory.get(category.id) ?? [];
		const levels = emptyHistogram();
		let repo = 0;
		let app = 0;
		let gate: string | null = null;
		for (const c of members) {
			levels[c.level as Level] += 1;
			if (c.scope === "repo") repo += 1;
			else app += 1;
			if (c.gate) gate = c.id;
		}
		return {
			id: category.id,
			title: category.title,
			criterionCount: members.length,
			repo,
			app,
			levels,
			gate,
		};
	});

	return {
		rubricVersion: RUBRIC_VERSION,
		categoryCount: rubric.categories.length,
		criterionCount: rubric.criteria.length,
		categories,
	};
}
