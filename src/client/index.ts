/**
 * Typed SDK over the domain core (SPEC §13.1) — the programmatic surface for
 * driving trellis from scripts and other tools.
 *
 * Every function here is a direct call to the SAME core service the CLI folds,
 * in-process: `audit` → {@link runAudit}, `drift` → {@link driftRepo}, `fleet` →
 * {@link runFleetTargets}, `report` → {@link buildReport}, `rubric` →
 * {@link summarizeRubric}. Because there is exactly one implementation of each
 * operation, a programmatic audit and a CLI audit exercise one code path and
 * cannot drift (proven by the deep-equal test in `index.test.ts`).
 *
 * Request types mirror the core option types and response types ARE the core
 * report types — re-exported below, each annotated with its source module. No
 * business logic lives in this file; it is pure type shaping over the core.
 */

import {
	assessFleet,
	type FleetReport,
	type FleetRunOptions,
	runFleetTargets,
} from "../fleet/index.ts"; // Mirrors src/fleet
import { buildReport, type HistoryReport, type ReportRunOptions } from "../history/index.ts"; // Mirrors src/history
import {
	type Assessment,
	type AuditRunOptions,
	assessReport,
	DEFAULT_MIN_LEVEL,
	FAIL_ON_MODES,
	type FailOnMode,
	type FailPolicy,
	type Report,
	runAudit,
} from "../report/index.ts"; // Mirrors src/report
import { loadRubric, type Rubric, type RubricSummary, summarizeRubric } from "../rubric/index.ts"; // Mirrors src/rubric
import { type DriftOptions, type DriftReport, driftRepo } from "../standards/index.ts"; // Mirrors src/standards

/** Re-exported core report types — the SDK's response shapes (SPEC §6.3, §10, §11). */
/** Re-exported exit-code assessment surface (SPEC §12), so a script applies the CLI's rule. */
export type {
	Assessment,
	DriftReport,
	FailOnMode,
	FailPolicy,
	FleetReport,
	HistoryReport,
	Report,
	Rubric,
	RubricSummary,
};
/** Re-exported rubric loader — `assessReport` needs the full {@link Rubric} (which criteria are gates). */
export { assessFleet, assessReport, DEFAULT_MIN_LEVEL, FAIL_ON_MODES, loadRubric };

/** Request for {@link audit}. Mirrors src/report {@link AuditRunOptions}. */
export type AuditRequest = AuditRunOptions;

/**
 * Audit one repo and return its §6.3 {@link Report}. Persists to the central
 * history unless `persist: false`. Identical to `trellis audit`.
 */
export function audit(repoPath: string, opts: AuditRequest = {}): Promise<Report> {
	return runAudit(repoPath, opts);
}

/** Request for {@link drift}. Mirrors src/standards {@link DriftOptions}. */
export type DriftRequest = DriftOptions;

/**
 * Compare one repo against the bundled canonical set and return its
 * {@link DriftReport} (SPEC §10). Identical to `trellis drift`.
 */
export function drift(repoPath: string, opts: DriftRequest = {}): DriftReport {
	return driftRepo(repoPath, opts);
}

/** Request for {@link fleet}. Mirrors src/fleet {@link FleetRunOptions}. */
export type FleetRequest = FleetRunOptions;

/**
 * Audit every target in a `targets.yaml` and return the aggregate
 * {@link FleetReport} (SPEC §6.5). Identical to `trellis fleet`.
 */
export function fleet(targetsPath: string, opts: FleetRequest = {}): Promise<FleetReport> {
	return runFleetTargets(targetsPath, opts);
}

/** Query for {@link report}. Mirrors src/history {@link ReportRunOptions}. */
export type ReportQuery = ReportRunOptions;

/**
 * Project the run-history dashboard from the central store (SPEC §11). Identical
 * to `trellis report`.
 */
export function report(query: ReportQuery = {}): HistoryReport {
	return buildReport(query);
}

/** Load + summarize the bundled rubric (SPEC §6.1). Identical to `trellis rubric`. */
export function rubric(): RubricSummary {
	return summarizeRubric(loadRubric());
}
