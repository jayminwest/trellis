/**
 * The provider-evidence policy family (SPEC §16.3, §16.5, §16.6 — plan
 * `pl-43c5` step 7, trellis-68b9).
 *
 * The declarative policy block can *demand* optional-provider evidence and
 * can aim its budget and new-finding checks at a provider's namespaced
 * evidence — without ever changing scoring (§16.5: provider observations are
 * unscored and a requirement never selects weights) or executing a provider
 * implicitly (§16.4: selection is a later, separate surface). Three routed
 * evaluations live here, each a pure function over the current report (and,
 * for new findings, the step-6 comparison):
 *
 * - **evidence-requirement** (`policy.requireEvidence`) — every named
 *   supported analysis must be carried `complete`. An unrequested,
 *   unavailable, unsupported or incomplete required analysis fails closed
 *   (exit `2`, the report still emitted) even when the native score is
 *   complete and clean. Requiring a capability the supported-provider table
 *   records as resolving to `unsupported` — the deferred SonarJS decision
 *   (§16.7) — is a located violation citing the recorded reason, never a
 *   crash or a silent pass. An absent optional provider with no requirement
 *   never violates policy.
 * - **metric budgets over provider evidence** — a budget key under the
 *   reserved `provider.` namespace (`provider.<id>.<metric>`) is evaluated
 *   only over that analysis's carried evidence: a `complete` analysis's
 *   emitted value compares against `max`; any other missing value is never a
 *   fabricated zero — the budget fails closed when the analysis is also
 *   required (`budget-evidence-missing`) and is skipped, with the absence
 *   stated, when it is not (`budget-evidence-absent`).
 * - **new findings over provider evidence** — a `failOnNew` kind under
 *   `provider.` is evaluated over the step-6 per-provider evidence
 *   comparison: only `comparable` evidence is diffed; a changed evidence
 *   basis skips the check (`evidence-noncomparable` — never fictitious
 *   churn, never a silent pass); absence on a side reads as `unrequested`
 *   there and never as a regression (§16.6).
 */
import {
	type AuditReport,
	carriedAnalyses,
	EVIDENCE_NAMESPACE,
	type Finding,
	isNamespacedEvidenceId,
	type MetricValue,
	type ProviderState,
	type ReportAnalysis,
} from "../contract/index.ts";
import { providerCapabilityStatus, SUPPORTED_PROVIDERS } from "../providers/capabilities.ts";
import type { ReportComparison } from "./compare.ts";
import type { EvidenceProviderComparison } from "./evidence.ts";
import type { PolicyReason, PolicyResult } from "./policy.ts";

/** Machine-readable reason codes for the provider-evidence policy routes (see the module docblock). */
export type EvidencePolicyReasonCode =
	| "requirement-analysis-unknown"
	| "requirement-analysis-unrequested"
	| "requirement-evidence-unsupported"
	| "requirement-evidence-unavailable"
	| "requirement-evidence-incomplete"
	| "budget-evidence-missing"
	| "budget-evidence-absent"
	| "evidence-noncomparable";

/** Cap on individually listed finding locations inside one reason message. */
const MAX_LISTED_LOCATIONS = 5;

/** The supported external provider analysis ids, sorted — the requirement vocabulary (§16.1). */
export function supportedProviderAnalysisIds(): string[] {
	return SUPPORTED_PROVIDERS.map((entry) => entry.providerId).sort();
}

/** Whether a policy subject (a budget key or a failOnNew kind) names a provider's namespaced evidence (§16.5). */
export function isProviderEvidenceId(id: string): boolean {
	return id.startsWith(`${EVIDENCE_NAMESPACE}.`);
}

/** The longest-first comparison for namespace matches (deterministic even for dotted provider ids). */
function byLongestProviderId(a: string, b: string): number {
	return b.length - a.length || a.localeCompare(b);
}

/** The carried analysis a namespaced evidence id belongs to: the exact metric owner, else the longest namespace match. */
function owningAnalysis(
	analyses: readonly ReportAnalysis[],
	evidenceId: string,
): ReportAnalysis | undefined {
	const byMetric = analyses.find((analysis) =>
		analysis.metrics?.some((metric) => metric.id === evidenceId),
	);
	if (byMetric !== undefined) return byMetric;
	const namespaced = analyses
		.filter((analysis) => isNamespacedEvidenceId(evidenceId, analysis.provider.id))
		.map((analysis) => analysis.provider.id);
	const providerId = namespaced.sort(byLongestProviderId)[0];
	return providerId === undefined
		? undefined
		: analyses.find((analysis) => analysis.provider.id === providerId);
}

/** The known supported provider a not-carried evidence id belongs to (longest id match), or `undefined`. */
function knownProviderForEvidenceId(evidenceId: string): string | undefined {
	return supportedProviderAnalysisIds()
		.filter((providerId) => isNamespacedEvidenceId(evidenceId, providerId))
		.sort(byLongestProviderId)[0];
}

/** The located note for a capability recorded as `unsupported` — the deferral decision, when one is recorded (§16.7). */
function deferredDecisionNote(providerId: string): string {
	const decision = providerCapabilityStatus(providerId)?.decision;
	return decision === undefined
		? ""
		: ` (deferred by ${decision.record}, issue ${decision.issue}; prerequisite ${decision.prerequisite})`;
}

/** One required analysis carried with a gap state: its state, located (§16.2 — the entry's own reason). */
function carriedGapReason(
	analysisId: string,
	state: Exclude<ProviderState, "complete">,
	reason: string | undefined,
): PolicyReason {
	const detail = reason === undefined ? "" : ` — ${reason}`;
	switch (state) {
		case "unrequested":
			return {
				code: "requirement-analysis-unrequested",
				message: `required analysis "${analysisId}" is carried unrequested: the run did not enable it`,
			};
		case "unavailable":
			return {
				code: "requirement-evidence-unavailable",
				message: `required analysis "${analysisId}" is unavailable${detail}`,
			};
		case "unsupported":
			return {
				code: "requirement-evidence-unsupported",
				message: `required analysis "${analysisId}" is unsupported${detail}`,
			};
		case "incomplete":
			return {
				code: "requirement-evidence-incomplete",
				message: `required analysis "${analysisId}" is incomplete${detail}`,
			};
	}
}

/**
 * Evaluate one `requireEvidence` entry (see the module docblock): a pass only
 * when the report carries the analysis `complete`; every gap, absence or
 * unknown id fails closed.
 */
export function assessEvidenceRequirement(report: AuditReport, analysisId: string): PolicyResult {
	const result: PolicyResult = {
		policy: "evidence-requirement",
		subject: analysisId,
		status: "pass",
		reasons: [],
	};
	const entry = carriedAnalyses(report).find((analysis) => analysis.provider.id === analysisId);
	if (entry !== undefined) {
		if (entry.state === "complete") return result;
		result.status = "fail";
		result.reasons.push(carriedGapReason(analysisId, entry.state, entry.reason));
		return result;
	}
	// Not carried: the run did not request it, or the capability cannot be
	// requested at all — both fail closed (§16.3), never a silent pass.
	result.status = "fail";
	const capability = providerCapabilityStatus(analysisId);
	if (capability === undefined) {
		result.reasons.push({
			code: "requirement-analysis-unknown",
			message: `required analysis "${analysisId}" names no supported provider analysis — supported: ${supportedProviderAnalysisIds().join(", ")}`,
		});
		return result;
	}
	if (capability.requestState === "unsupported") {
		result.reasons.push({
			code: "requirement-evidence-unsupported",
			message: `required analysis "${analysisId}" is not carried and its capability resolves to unsupported: ${capability.reason}${deferredDecisionNote(analysisId)}`,
		});
		return result;
	}
	result.reasons.push({
		code: "requirement-analysis-unrequested",
		message: `required analysis "${analysisId}" is not carried by this report: the run did not request it`,
	});
	return result;
}

/** Why a budgeted provider metric has no complete value: the located state of the analysis (or its metric). */
function missingValueCause(
	owner: ReportAnalysis | undefined,
	metricId: string,
	providerId: string,
): string {
	if (owner === undefined) {
		const capability = providerCapabilityStatus(providerId);
		return capability === undefined || capability.requestState !== "unsupported"
			? "not carried by this report (the run did not request it)"
			: `not carried by this report — its capability resolves to unsupported (${capability.reason})`;
	}
	if (owner.state === "complete") {
		return `carried complete, but its "${metricId}" metric carries no complete value`;
	}
	const detail = owner.reason === undefined ? "" : ` — ${owner.reason}`;
	return owner.state === "unrequested"
		? "carried unrequested (the run did not enable it)"
		: `${owner.state}${detail}`;
}

/**
 * Evaluate one metric budget whose key names a provider's namespaced evidence
 * (`provider.<id>.<metric>`; see the module docblock). Only a `complete`
 * analysis's emitted value compares against `max` — a missing value is never
 * a fabricated zero: it fails closed when the owning analysis is also
 * required, and is skipped with the absence stated when it is not.
 */
export function assessProviderEvidenceBudget(
	report: AuditReport,
	metricId: string,
	max: number,
	requiredAnalyses: ReadonlySet<string>,
): PolicyResult {
	const result: PolicyResult = {
		policy: "metric-budget",
		subject: metricId,
		status: "pass",
		reasons: [],
	};
	const analyses = carriedAnalyses(report);
	const owner = owningAnalysis(analyses, metricId);
	const metric: MetricValue | undefined = owner?.metrics?.find(
		(candidate) => candidate.id === metricId,
	);
	if (owner !== undefined && owner.state === "complete" && metric === undefined) {
		// The complete analysis ran and did not emit the budgeted id — the key
		// names nothing, exactly like a budget over an unknown native metric.
		result.status = "fail";
		result.reasons.push({
			code: "budget-metric-unknown",
			message: `budgeted metric "${metricId}" is not emitted by the complete "${owner.provider.id}" analysis — check the budget configuration`,
		});
		return result;
	}
	// Only a complete analysis's complete value is budgetable: partial
	// evidence (§16.2) never feeds a budget — fewer analyzed files must never
	// pass as a smaller measured value.
	if (owner?.state === "complete" && metric?.state === "complete" && metric.value !== undefined) {
		if (metric.value > max) {
			result.status = "fail";
			result.reasons.push({
				code: "budget-exceeded",
				message: `metric "${metricId}" is ${metric.value} ${metric.unit}, over the budgeted max ${max}`,
			});
		}
		return result;
	}
	// The budgeted value is missing. Name the owning provider: the carried
	// analysis when there is one, else the known supported provider — an id
	// belonging to no supported analysis names nothing and fails as unknown.
	const providerId = owner?.provider.id ?? knownProviderForEvidenceId(metricId);
	if (providerId === undefined) {
		result.status = "fail";
		result.reasons.push({
			code: "budget-metric-unknown",
			message: `budgeted metric "${metricId}" names no supported provider analysis — supported: ${supportedProviderAnalysisIds().join(", ")}`,
		});
		return result;
	}
	const cause = missingValueCause(owner, metricId, providerId);
	if (requiredAnalyses.has(providerId)) {
		result.status = "fail";
		result.reasons.push({
			code: "budget-evidence-missing",
			message: `budgeted metric "${metricId}" has no value: the "${providerId}" analysis is ${cause} — a required analysis's budget fails closed`,
		});
		return result;
	}
	result.status = "skipped";
	result.reasons.push({
		code: "budget-evidence-absent",
		message: `budgeted metric "${metricId}" was not evaluated: the "${providerId}" analysis is ${cause} and no requirement demands it — no zero value was fabricated`,
	});
	return result;
}

/** The bounded location listing shared with the native new-findings message format. */
function locationsMessage(found: readonly Finding[], kind: string): string {
	const locations = found
		.slice(0, MAX_LISTED_LOCATIONS)
		.map((finding) => `${finding.path}:${finding.range.start.line}`);
	const rest = found.length - locations.length;
	return `${found.length} new "${kind}" finding(s) vs the baseline: ${locations.join(", ")}${rest > 0 ? ` (+${rest} more)` : ""}`;
}

/** The step-6 comparison entry a namespaced finding kind belongs to (longest provider-id match). */
function owningProviderComparison(
	kind: string,
	comparison: ReportComparison,
): EvidenceProviderComparison | undefined {
	const providerId = comparison.evidence.providers
		.map((provider) => provider.providerId)
		.filter((id) => isNamespacedEvidenceId(kind, id))
		.sort(byLongestProviderId)[0];
	return comparison.evidence.providers.find((provider) => provider.providerId === providerId);
}

/**
 * Evaluate one `failOnNew` kind that names a provider's namespaced finding
 * kind (see the module docblock): only `comparable` evidence is diffed; a
 * changed basis skips the check; absence on a side never reads as regression
 * churn (§16.6).
 */
export function assessProviderNewFindings(
	kind: string,
	comparison: ReportComparison,
): PolicyResult {
	const result: PolicyResult = {
		policy: "new-findings",
		subject: kind,
		status: "pass",
		reasons: [],
	};
	const provider = owningProviderComparison(kind, comparison);
	if (provider === undefined) return result; // carried on neither side: no finding of this kind can exist
	if (provider.status === "noncomparable") {
		result.status = "skipped";
		result.reasons.push({
			code: "evidence-noncomparable",
			message: `the "${provider.providerId}" evidence basis is not comparable between the runs (${provider.reasons.map((reason) => reason.message).join("; ")}) — new "${kind}" findings cannot be claimed against it`,
		});
		return result;
	}
	if (provider.status !== "comparable" || provider.findings === undefined) return result;
	const found = provider.findings.new.filter((finding) => finding.kind === kind);
	if (found.length > 0) {
		result.status = "fail";
		result.reasons.push({ code: "new-finding", message: locationsMessage(found, kind) });
	}
	return result;
}
