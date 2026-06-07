/**
 * Scoring engine (SPEC §3.4) — pure, surface-agnostic core. Pass-rate, the
 * coverage clamp, naKind handling, 20-pt bands, and repo/app aggregation, all as
 * I/O-free functions the CLI and SDK fold identically.
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
export { gateFails } from "./gate.ts";
export { type ScoreCounts, type Scorecard, scoreRun } from "./score.ts";
