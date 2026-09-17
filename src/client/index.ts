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
 * `fleet` / `report` (trellis-8366, SPEC §11) fold the same deterministic
 * core: `fleet` → {@link runFleetTargets} (multi-repo orchestration over
 * `runWorkspaceAudit`, with canonical drift as a separate non-scoring
 * capability) and `report` → {@link buildReport} (the sloppiness history
 * dashboard, with legacy readiness runs visibly distinct and never trended
 * against the index, SPEC §10). `drift` remains a separate, non-scoring
 * canonical-configuration capability. Readiness catalog and assessment
 * exports were retired with the deterministic release.
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
	type FleetAssessment,
	type FleetReport,
	type FleetRunOptions,
	runFleetTargets,
} from "../fleet/index.ts"; // Mirrors src/fleet
import { buildReport, type HistoryReport, type ReportRunOptions } from "../history/index.ts"; // Mirrors src/history
import { type DriftOptions, type DriftReport, driftRepo } from "../standards/index.ts"; // Mirrors src/standards

/** Re-exported core report types — the SDK's response shapes (SPEC §6.4, §9). */
export type {
	AuditConfig,
	AuditReport,
	DriftReport,
	FleetAssessment,
	FleetReport,
	HistoryReport,
	PolicyAssessment,
	PolicyReason,
	PolicyReasonCode,
	PolicyResult,
	ReportComparison,
	WorkspaceAuditResult,
};
/** Re-exported core services and the exit-code rules (SPEC §9, §12), so a script applies the CLI's rule. */
export { AuditRunError, assessFleet, assessPolicy };

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
 * sloppiness index). Identical to `trellis drift`.
 */
export function drift(repoPath: string, opts: DriftRequest = {}): DriftReport {
	return driftRepo(repoPath, opts);
}

/** Request for {@link fleet}. Mirrors src/fleet {@link FleetRunOptions}. */
export type FleetRequest = FleetRunOptions;

/**
 * Audit every target in a `targets.yaml` through the deterministic core and
 * return the aggregate {@link FleetReport} — each entry preserves the
 * target's full §6.4 report (findings, completeness) and its declarative §9
 * policy assessment; canonical drift rides along as a separate, non-scoring
 * capability (SPEC §11). Stateless by default — pass `history: true` to
 * record each run and surface index moves against stored baselines.
 * Identical to `trellis fleet`.
 */
export function fleet(targetsPath: string, opts: FleetRequest = {}): Promise<FleetReport> {
	return runFleetTargets(targetsPath, opts);
}

/** Query for {@link report}. Mirrors src/history {@link ReportRunOptions}. */
export type ReportQuery = ReportRunOptions;

/**
 * Project the run-history dashboard from the central store: the sloppiness
 * snapshot and per-repo scored-basis-compatible index series (§3.5, §16.6),
 * with legacy readiness history in a visibly distinct section that is never
 * compared with the sloppiness index (SPEC §10). Identical to `trellis report`.
 */
export function report(query: ReportQuery = {}): HistoryReport {
	return buildReport(query);
}
