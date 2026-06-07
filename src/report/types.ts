/**
 * The audit report (SPEC §6.3) — the per-run document the whole pipeline
 * produces and the renderers project. One {@link Report} is the surface-agnostic
 * result of {@link auditRepo}: the scored level/pass-rate/coverage, the
 * discovered app map, and the per-criterion §6.2 entries keyed by criterion id.
 *
 * Field order here is the canonical JSON key order — the JSON renderer relies on
 * it (and on `criteria` being built in rubric order) for byte-stable output. The
 * only field not derived from repo state is `scoredAt`; everything else is a pure
 * function of the checkout, the rubric version, and the detector set.
 *
 * `drift` (§10) is present only when the audit was given a canonical version to
 * compare against; `changesSinceLastRun` (§11) is present only when the audit was
 * given the repo's prior run to compare against — both are superset keys appended
 * last, so a run without them serializes exactly as before.
 */

import type { Level } from "../rubric/index.ts";
import type { NaKind, ScorecardEntry } from "../scoring/index.ts";
import type { DriftReport } from "../standards/index.ts";

/** One app's entry in the report's §6.3 `apps` map. */
export interface AppDescriptor {
	/** Human label (package name/description, else dir basename). */
	description: string;
}

/** The per-run audit report (SPEC §6.3). */
export interface Report {
	/** Repo id — the basename of the audited path (targets.yaml id lands with the fleet). */
	repo: string;
	/** Rubric version the run scored against (SPEC §6.1). */
	rubricVersion: string;
	/** ISO-8601 wall-clock time the run was scored — the sole non-repo-derived field. */
	scoredAt: string;
	/** Resolved `HEAD` commit sha, or `"unknown"` when the path is not a git repo. */
	commit: string;
	/** Coverage-clamped maturity level (SPEC §3.4). */
	level: Level;
	/** Mean per-criterion score over counted criteria (SPEC §3.4). */
	passRate: number;
	/** counted / (counted + no-detector + skipped) — N/A excluded (SPEC §3.2). */
	coverage: number;
	/** Discovered apps, keyed by repo-relative path (`.` for the repo root). */
	apps: Record<string, AppDescriptor>;
	/** Per-criterion §6.2 entries, in rubric order (the JSON key order). */
	criteria: Record<string, ScorecardEntry>;
	/** Canonical-config drift (SPEC §10), present only when a canonical version was compared. */
	drift?: DriftReport;
	/** Per-criterion delta vs the repo's prior run (SPEC §11), present only when a prior run was compared. */
	changesSinceLastRun?: ChangesSinceLastRun;
}

/**
 * The §11 changes-since-last-run delta types live here (the canonical types
 * module) rather than beside their logic in `changes.ts`, so that `types.ts` can
 * reference {@link ChangesSinceLastRun} from {@link Report} without forming an
 * import cycle with `changes.ts` (which depends on {@link Report}).
 */

/** A criterion's coarse standing in one run, folding the §6.2 entry to one label. */
export type CriterionStatus = "pass" | "fail" | "partial" | "not-applicable" | "no-detector";

/** The kind of move a criterion made between the two runs (one per transition). */
export type TransitionKind =
	/** Left full-pass (`N/N` → anything counted-but-lower). */
	| "pass-to-fail"
	/** Reached full-pass (anything counted-but-lower → `N/N`). */
	| "fail-to-pass"
	/** An N/A-kind shift: counted↔N/A, or not-applicable↔no-detector. */
	| "na-kind"
	/** The denominator (app count) changed while the status held. */
	| "denominator"
	/** The numerator moved within a partial state (same denominator, no boundary cross). */
	| "score"
	/** Present this run, absent in the prior one (only possible across rubric versions). */
	| "added"
	/** Present in the prior run, absent this one (only possible across rubric versions). */
	| "removed";

/** A criterion's measurable state in one run — the before/after of a transition. */
export interface CriterionSnapshot {
	status: CriterionStatus;
	numerator: number | null;
	denominator: number;
	naKind: NaKind | null;
}

/** One criterion's move between the prior run and this one. */
export interface CriterionTransition {
	/** Criterion id (§6.1). */
	criterion: string;
	/** The nature of the move. */
	kind: TransitionKind;
	/** Prior-run state, or `null` when the criterion is newly `added`. */
	before: CriterionSnapshot | null;
	/** This-run state, or `null` when the criterion was `removed`. */
	after: CriterionSnapshot | null;
}

/** The §11 delta of a run against the most recent prior run for the same repo. */
export interface ChangesSinceLastRun {
	/** `scoredAt` of the run compared against (the most recent prior run for this repo). */
	previousScoredAt: string;
	/** The prior run's resolved commit. */
	previousCommit: string;
	/** The prior run's rubric version. */
	previousRubricVersion: string;
	/** The prior run's coverage-clamped level. */
	previousLevel: Level;
	/** This run's coverage-clamped level. */
	level: Level;
	/** `level − previousLevel` — the net maturity move. */
	netLevelMove: number;
	/** True when the two runs scored against different rubric versions. */
	rubricVersionChanged: boolean;
	/**
	 * `"code"` when both runs share a rubric version (a real regression/improvement);
	 * `"possibly-rubric"` when they differ (the delta may be rubric-driven, SPEC §11).
	 */
	attribution: "code" | "possibly-rubric";
	/** Per-criterion moves, in this run's rubric order (removed criteria appended last). */
	transitions: CriterionTransition[];
}
