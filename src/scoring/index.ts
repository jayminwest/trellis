/**
 * Scoring — two engines while the pivot (SPEC §14) completes:
 *
 * - **The provisional sloppiness formula** (SPEC §7, trellis-00d5):
 *   {@link scoreSloppiness} is a pure function of the raw contract metrics,
 *   with every constant pinned in {@link SCORING_FORMULA} under
 *   `SCORING_VERSION` (`0.2.0-provisional`).
 * - The **legacy readiness scorecard** (pass-rate, coverage clamp, naKind
 *   handling, 20-pt bands, repo/app aggregation) — transitional; it leaves
 *   with the rubric in the staged plan.
 *
 * Both are I/O-free cores the CLI and SDK fold identically.
 */

export {
	type AppResult,
	aggregateAppScope,
	aggregateRepoScope,
	OUTCOMES,
	type Outcome,
	type RepoResult,
} from "./aggregate.ts";
export { band, clampLevel } from "./band.ts";
export {
	type Disposition,
	disposition,
	MAX_RATIONALE,
	NA_KINDS,
	type NaKind,
	perCriterionScore,
	type ScorecardEntry,
	scorecardEntrySchema,
} from "./entry.ts";
export {
	type ApportionPart,
	apportionPoints,
	clamp01,
	type FormulaDimension,
	type FormulaTerm,
	normalizeTerm,
	roundHalfUp,
	SCORING_FORMULA,
	type ScoringFormula,
} from "./formula.ts";
export { gateFails } from "./gate.ts";
export { type ScoreCounts, type Scorecard, scoreRun } from "./score.ts";
export {
	type DimensionScore,
	type DimensionState,
	type ScoredTerm,
	type SloppinessScore,
	scoreSloppiness,
} from "./sloppiness.ts";
