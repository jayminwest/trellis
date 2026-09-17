/**
 * Baseline comparison of two §6.4 report artifacts (SPEC §9, trellis-942c;
 * per-basis compatibility — plan `pl-43c5` step 6, trellis-bd0c).
 *
 * {@link compareReports} is a pure function over two already-validated
 * {@link AuditReport}s — no Git, no SQLite, no filesystem. Loading the
 * artifacts lives in `load.ts`; policy evaluation lives in `policy.ts`.
 * Compatibility is evaluated **per basis** (§16.6), never per whole report:
 *
 * - the **scored basis** (`compatibility`, from `compatibility.ts`) gates
 *   the native index, raw-metric and finding deltas: analyzer/scoring
 *   versions, scored metric catalogs, supplied configurations, and the
 *   scored analyses' recorded measurement semantics. Incompatible pairs
 *   fail closed — `comparable: false`, no deltas computed, never silently
 *   compared. Advisory-only provider changes never enter this basis.
 * - the **evidence basis** (`evidence`, from `evidence.ts`) is assessed
 *   independently per carried provider: identical producer/scope semantics
 *   compare (a changed source revision is the expected input, caveated),
 *   and a changed provider/parser/options/selection basis is an explicit
 *   noncomparable dimension — never fictitious deltas or finding churn.
 *
 * The two bases are independent in both directions: an incompatible scored
 * pair still carries its per-provider evidence verdicts, and a
 * noncomparable provider dimension never fragments the native score
 * comparison. Pre-provider (schema 1.0.0) artifacts compare with each other
 * under their original interpretation, and a 1.0.0 ↔ 1.1.0 pair compares
 * the scored basis explicitly (`schema-span` caveat) while the pre-provider
 * side's provider evidence reads as unrequested — never a regression.
 */
import type { AuditReport } from "../contract/index.ts";
import { isSupportedSchemaVersion } from "../contract/index.ts";
import {
	assessScoredBasis,
	type CompareOptions,
	type ComparisonCompatibility,
} from "./compatibility.ts";
import {
	compareFindings,
	compareMetrics,
	type FindingComparison,
	type MetricDelta,
	type ScoreDelta,
} from "./diff.ts";
import { compareEvidence, type EvidenceComparison } from "./evidence.ts";

/** The result of comparing two report artifacts (see the module docblock). */
export interface ReportComparison {
	/** The scored-basis compatibility: gates `score`/`metrics`/`findings` and the baseline-dependent policies. */
	compatibility: ComparisonCompatibility;
	/** Present only when the scored basis is comparable — never silently computed otherwise. */
	score?: ScoreDelta;
	/**
	 * Per-metric deltas over the union of metric ids on either report
	 * (advisory additions/removals appear with a `null` side), sorted by id.
	 */
	metrics?: MetricDelta[];
	findings?: FindingComparison;
	/** The per-provider evidence-basis comparison (§16.6) — independent of the scored basis. */
	evidence: EvidenceComparison;
}

/**
 * Compare two validated §6.4 reports (see the module docblock for the
 * per-basis compatibility and matching rules). Pure: no I/O of any kind.
 */
export function compareReports(
	baseline: AuditReport,
	current: AuditReport,
	options: CompareOptions = {},
): ReportComparison {
	const compatibility = assessScoredBasis(baseline, current, options);
	// Evidence verdicts are only decidable over readable schema versions; an
	// uninterpretable pair carries its hard refusal and no evidence at all.
	const readable =
		isSupportedSchemaVersion(baseline.schemaVersion) &&
		isSupportedSchemaVersion(current.schemaVersion);
	const evidence = readable ? compareEvidence(baseline, current) : { providers: [] };
	if (!compatibility.comparable) return { compatibility, evidence };
	return {
		compatibility,
		evidence,
		score: {
			baseline: baseline.score.index,
			current: current.score.index,
			delta: current.score.index - baseline.score.index,
		},
		metrics: compareMetrics(baseline, current),
		findings: compareFindings(baseline.findings, current.findings),
	};
}
