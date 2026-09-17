/**
 * Baseline comparison and failure policies over §6.4 report artifacts
 * (SPEC §9, trellis-942c).
 *
 * - `load.ts` — the only I/O: read + re-validate a saved JSON report (no Git,
 *   no SQLite); failures are operational errors.
 * - `compare.ts` — pure comparison of two validated reports: compatibility
 *   gate, score/metric deltas, conservative finding classification.
 * - `policy.ts` — pure, independent evaluation of the §6.5 failure policy
 *   (max index, metric budgets, score regression, new findings) with
 *   structured reason codes.
 *
 * CLI (`trellis compare`, `--baseline`) and SDK wiring landed with
 * trellis-9a88; history persistence consumes these artifacts with
 * trellis-424d.
 */
export {
	type CompareOptions,
	type ComparisonCompatibility,
	type CompatibilityIssue,
	compareFindings,
	compareMetrics,
	compareReports,
	type FindingComparison,
	type MetricDelta,
	type MetricSide,
	type PersistentFinding,
	type ReportComparison,
	type ScoreDelta,
} from "./compare.ts";
export { compareArtifacts, loadReportArtifact, ReportArtifactError } from "./load.ts";
export {
	type AssessPolicyOptions,
	assessPolicy,
	type PolicyAssessment,
	type PolicyKind,
	type PolicyReason,
	type PolicyReasonCode,
	type PolicyResult,
} from "./policy.ts";
