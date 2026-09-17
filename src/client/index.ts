/**
 * Typed SDK over the domain core (SPEC §13.1) — the programmatic surface for
 * driving trellis from scripts and other tools.
 *
 * Every function here is a direct call to the SAME core service the CLI folds,
 * in-process: `audit` → {@link runWorkspaceAudit}, `compare` →
 * {@link compareArtifacts}, `drift` → {@link driftRepo}, `fleet` →
 * {@link runFleetTargets}, `report` → {@link buildReport}, `rubric` →
 * {@link summarizeRubric}. Because there is exactly one implementation of each
 * operation, a programmatic audit and a CLI audit exercise one measurement and
 * policy code path and cannot drift (proven by the deep-equal test in
 * `index.test.ts`).
 *
 * Request types mirror the core option types and response types ARE the core
 * report types — re-exported below, each annotated with its source module. No
 * business logic lives in this file; it is pure type shaping over the core.
 *
 * Transitional (SPEC §14): `audit`/`compare` are the deterministic
 * sloppiness surface (trellis-9a88); `fleet`/`report`/`rubric`/`drift` still
 * wrap the legacy readiness core until the staged plan adapts them
 * (trellis-8366).
 */

import {
	runWorkspaceAudit,
	type WorkspaceAuditOptions,
	type WorkspaceAuditResult,
} from "../audit/index.ts"; // Mirrors src/audit
import {
	assessPolicy,
	compareArtifacts,
	type PolicyAssessment,
	type ReportComparison,
} from "../compare/index.ts"; // Mirrors src/compare
import type { AuditConfig, AuditReport, PolicyConfig } from "../contract/index.ts"; // Mirrors src/contract
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

/** Re-exported core report types — the SDK's response shapes (SPEC §6.4, §9, §10, §11). */
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
	PolicyConfig,
	Report,
	ReportComparison,
	Rubric,
	RubricSummary,
	WorkspaceAuditResult,
};
/** Re-exported core loaders/rules — the policy and exit-code surfaces (SPEC §9, §12). */
export { assessFleet, assessPolicy, assessReport, DEFAULT_MIN_LEVEL, FAIL_ON_MODES, loadRubric };

/** Request for {@link audit}. Mirrors src/audit {@link WorkspaceAuditOptions}. */
export type AuditRequest = WorkspaceAuditOptions;

/**
 * Audit one workspace and return the composed {@link WorkspaceAuditResult} —
 * the §6.4 report, the baseline comparison (when `baselinePath` is given), and
 * the declarative-policy assessment. Stateless unless `history` is set.
 * Identical to `trellis audit`.
 */
export function audit(repoPath: string, opts: AuditRequest = {}): Promise<WorkspaceAuditResult> {
	return runWorkspaceAudit(repoPath, opts);
}

/**
 * Compare two saved audit report artifacts (`baselinePath` vs `currentPath`)
 * without an audit (SPEC §9). Identical to `trellis compare`.
 */
export function compare(baselinePath: string, currentPath: string): Promise<ReportComparison> {
	return compareArtifacts(baselinePath, currentPath);
}

/** Request for {@link drift}. Mirrors src/standards {@link DriftOptions}. */
export type DriftRequest = DriftOptions;

/**
 * Compare one repo against the bundled canonical set and return its
 * {@link DriftReport} (SPEC §11). Identical to `trellis drift`.
 */
export function drift(repoPath: string, opts: DriftRequest = {}): DriftReport {
	return driftRepo(repoPath, opts);
}

/** Request for {@link fleet}. Mirrors src/fleet {@link FleetRunOptions}. */
export type FleetRequest = FleetRunOptions;

/**
 * Audit every target in a `targets.yaml` and return the aggregate
 * {@link FleetReport} (SPEC §11). Identical to `trellis fleet`.
 */
export function fleet(targetsPath: string, opts: FleetRequest = {}): Promise<FleetReport> {
	return runFleetTargets(targetsPath, opts);
}

/** Query for {@link report}. Mirrors src/history {@link ReportRunOptions}. */
export type ReportQuery = ReportRunOptions;

/**
 * Project the run-history dashboard from the central store (SPEC §10). Identical
 * to `trellis report`.
 */
export function report(query: ReportQuery = {}): HistoryReport {
	return buildReport(query);
}

/** Load + summarize the bundled rubric (transitional readiness surface). Identical to `trellis rubric`. */
export function rubric(): RubricSummary {
	return summarizeRubric(loadRubric());
}
