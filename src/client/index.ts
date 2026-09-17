/**
 * Typed SDK over the domain core (SPEC §13.1) — the programmatic surface for
 * driving trellis from scripts and other tools.
 *
 * Every function here is a direct call to the SAME core service the CLI folds,
 * in-process: `audit` → {@link runWorkspaceAudit} (the deterministic audit:
 * configuration → measurement → baseline resolution → policy assessment →
 * opt-in history), `compare` → {@link runComparison} (artifact comparison
 * without an audit). Because there is exactly one implementation of each
 * operation, a programmatic audit and a CLI audit exercise one code path and
 * cannot drift (proven by the deep-equal test in `index.test.ts`).
 *
 * Transitional (SPEC §14): `drift` / `fleet` / `report` / `rubric` still wrap
 * the legacy readiness services until trellis-8366 adapts them; the
 * sloppiness surface above is the pivoted product.
 *
 * Request types mirror the core option types and response types ARE the core
 * report types — re-exported below, each annotated with its source module. No
 * business logic lives in this file; it is pure type shaping over the core.
 */

import {
	AuditRunError,
	runWorkspaceAudit,
	type WorkspaceAuditOptions,
	type WorkspaceAuditResult,
} from "../audit/index.ts"; // Mirrors src/audit
import {
	assessPolicy,
	type CompareRunOptions,
	type CompareRunResult,
	type PolicyAssessment,
	type PolicyReason,
	type PolicyReasonCode,
	type PolicyResult,
	type ReportComparison,
	runComparison,
} from "../compare/index.ts"; // Mirrors src/compare
import type { AuditConfig, AuditReport } from "../contract/index.ts"; // Mirrors src/contract
import {
	assessFleet,
	type FleetReport,
	type FleetRunOptions,
	runFleetTargets,
} from "../fleet/index.ts"; // Mirrors src/fleet
import { buildReport, type HistoryReport, type ReportRunOptions } from "../history/index.ts"; // Mirrors src/history
import {
	type Assessment,
	assessReport,
	DEFAULT_MIN_LEVEL,
	FAIL_ON_MODES,
	type FailOnMode,
	type FailPolicy,
	type Report,
} from "../report/index.ts"; // Mirrors src/report
import { loadRubric, type Rubric, type RubricSummary, summarizeRubric } from "../rubric/index.ts"; // Mirrors src/rubric
import { type DriftOptions, type DriftReport, driftRepo } from "../standards/index.ts"; // Mirrors src/standards

/** Re-exported core report types — the SDK's response shapes (SPEC §6.4, §9). */
export type {
	Assessment,
	AuditConfig,
	AuditReport,
	DriftReport,
	FailOnMode,
	FailPolicy,
	FleetReport,
	HistoryReport,
	PolicyAssessment,
	PolicyReason,
	PolicyReasonCode,
	PolicyResult,
	Report,
	ReportComparison,
	Rubric,
	RubricSummary,
	WorkspaceAuditResult,
};
/** Re-exported core services and the exit-code rules (SPEC §9, §12), so a script applies the CLI's rule. */
export {
	AuditRunError,
	assessFleet,
	assessPolicy,
	assessReport,
	DEFAULT_MIN_LEVEL,
	FAIL_ON_MODES,
	loadRubric,
};

/** Request for {@link audit}. Mirrors src/audit {@link WorkspaceAuditOptions}. */
export type AuditRequest = WorkspaceAuditOptions;

/**
 * Audit one workspace and return its §6.4 report plus the policy assessment
 * ({@link WorkspaceAuditResult}). Stateless by default — pass
 * `history: true` to record the run and resolve a stored baseline, or
 * `baselinePath` for an explicit artifact. Identical to `trellis audit`.
 */
export function audit(repoPath: string, opts: AuditRequest = {}): Promise<WorkspaceAuditResult> {
	return runWorkspaceAudit(repoPath, opts);
}

/** Request for {@link compare}. Mirrors src/compare {@link CompareRunOptions}. */
export type CompareRequest = CompareRunOptions;

/**
 * Compare two saved report artifacts without running an audit (SPEC §9) and
 * return the {@link CompareRunResult} — the pure comparison plus the policy
 * assessment when a configuration is supplied. Identical to `trellis compare`.
 */
export function compare(
	baselinePath: string,
	currentPath: string,
	opts: CompareRequest = {},
): Promise<CompareRunResult> {
	return runComparison(baselinePath, currentPath, opts);
}

/** Request for {@link drift}. Mirrors src/standards {@link DriftOptions}. */
export type DriftRequest = DriftOptions;

/**
 * Compare one repo against the bundled canonical set and return its
 * {@link DriftReport} (SPEC §11 — a separate capability that never enters the
 * sloppiness index). Identical to `trellis drift`. Transitional legacy surface.
 */
export function drift(repoPath: string, opts: DriftRequest = {}): DriftReport {
	return driftRepo(repoPath, opts);
}

/** Request for {@link fleet}. Mirrors src/fleet {@link FleetRunOptions}. */
export type FleetRequest = FleetRunOptions;

/**
 * Audit every target in a `targets.yaml` and return the aggregate
 * {@link FleetReport}. Identical to `trellis fleet`. Transitional legacy
 * surface — trellis-8366 adapts it to the deterministic core.
 */
export function fleet(targetsPath: string, opts: FleetRequest = {}): Promise<FleetReport> {
	return runFleetTargets(targetsPath, opts);
}

/** Query for {@link report}. Mirrors src/history {@link ReportRunOptions}. */
export type ReportQuery = ReportRunOptions;

/**
 * Project the run-history dashboard from the central store. Identical to
 * `trellis report`. Transitional legacy surface — trellis-8366 adapts the
 * history views to the new measurements.
 */
export function report(query: ReportQuery = {}): HistoryReport {
	return buildReport(query);
}

/** Load + summarize the bundled rubric. Identical to `trellis rubric`. Transitional legacy surface. */
export function rubric(): RubricSummary {
	return summarizeRubric(loadRubric());
}
