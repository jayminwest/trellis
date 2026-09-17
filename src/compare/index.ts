/**
 * Baseline comparison and failure policies over §6.4 report artifacts
 * (SPEC §9, trellis-942c; per-basis compatibility — plan `pl-43c5` step 6,
 * trellis-bd0c).
 *
 * - `load.ts` — the only I/O: read + re-validate a saved JSON report (no Git,
 *   no SQLite); failures are operational errors.
 * - `diff.ts` — the pure metric/finding diffs shared by both bases.
 * - `compatibility.ts` — the **scored-basis** compatibility assessment: the
 *   established fail-closed rules (schema/analyzer/scoring versions, scored
 *   metric catalogs, supplied configurations) plus the scored analyses'
 *   recorded measurement semantics; advisory-only changes never enter it.
 * - `evidence.ts` — the **evidence-basis** comparison, per carried provider:
 *   producer/scope/content bases evaluated separately, absence reading as
 *   unrequested, and namespaced metric/finding diffs only for identical,
 *   complete external analyses.
 * - `compare.ts` — the composition: `compareReports` gates the native
 *   score/metric/finding deltas on the scored basis while carrying the
 *   independent evidence verdicts.
 * - `policy.ts` — pure, independent evaluation of the §6.5 failure policy
 *   (max index, metric budgets, score regression, new findings) with
 *   structured reason codes.
 * - `run.ts` — the `trellis compare` service (trellis-9a88): load two
 *   artifacts, compare them, and evaluate a supplied configuration's policy.
 *   The CLI and SDK both fold it — one code path.
 */

export { compareReports, type ReportComparison } from "./compare.ts";
export {
	assessScoredBasis,
	type CompareOptions,
	type ComparisonCompatibility,
	type CompatibilityIssue,
} from "./compatibility.ts";
export {
	compareFindings,
	compareMetricRecords,
	compareMetrics,
	compareMetricValues,
	type FindingComparison,
	type MetricDelta,
	type MetricSide,
	type PersistentFinding,
	type ScoreDelta,
} from "./diff.ts";
export {
	type CarriedProducer,
	compareEvidence,
	type EvidenceComparison,
	type EvidenceIssue,
	type EvidenceIssueCode,
	type EvidenceProviderComparison,
	type EvidenceProviderStatus,
	type EvidenceSide,
} from "./evidence.ts";
export { loadReportArtifact, ReportArtifactError } from "./load.ts";
export {
	type AssessPolicyOptions,
	assessPolicy,
	type PolicyAssessment,
	type PolicyKind,
	type PolicyReason,
	type PolicyReasonCode,
	type PolicyResult,
} from "./policy.ts";
export {
	type CompareRunOptions,
	type CompareRunResult,
	runComparison,
} from "./run.ts";
