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
 * compare against; `changesSinceLastRun` (§11) is deliberately absent until its
 * milestone (trellis-dde8) lands — adding it later is a superset change that does
 * not perturb existing keys.
 */

import type { Level } from "../rubric/index.ts";
import type { ScorecardEntry } from "../scoring/index.ts";
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
}
