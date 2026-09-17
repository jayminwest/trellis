/**
 * Failure-policy assessment over a §6.4 report (SPEC §6.5, §9, trellis-942c).
 *
 * {@link assessPolicy} is a pure function: given the current report, the
 * declarative {@link import("../contract/index.ts").PolicyConfig}, and an
 * optional baseline artifact, it evaluates every configured policy
 * **independently** and returns structured, coded reasons. Policies never
 * mutate scoring (§7) and never suppress one another — a better aggregate
 * index cannot hide a configured new-cycle or new-hotspot failure (§9);
 * `failed` is the OR of the individual results.
 *
 * The four policy families:
 *
 * - `max-index` — `policy.maxIndex`: the current index must not exceed it.
 * - `metric-budget` — each `policy.budgets` entry: the current raw metric
 *   value must not exceed `max`. A budget naming a metric absent from the
 *   report fails closed (`budget-metric-unknown` — almost certainly a
 *   configuration mistake); a budget over a metric without a value
 *   (`incomplete`/`unsupported`/`not-applicable`) is `skipped` with
 *   `budget-metric-unevaluable` — the partial headline already flags the run.
 * - `score-regression` — `policy.regression`, requires a baseline. The
 *   **absolute** knob `maxIncrease` bounds the index increase in points; the
 *   **relative** knob `maxIncreasePercent` bounds it as a percentage of the
 *   baseline index (`increase > baseline.index × percent / 100` fails). Both
 *   configured ⇒ exceeding either fails; neither configured ⇒ zero tolerance.
 * - `new-findings` — `policy.failOnNew` kinds, requires a baseline: any
 *   baseline-relative **new** finding of a listed kind fails (`new-finding`).
 *
 * Baseline-dependent policies (`score-regression`, `new-findings`): no
 * baseline at all ⇒ `skipped` with `baseline-absent` (a first run has nothing
 * to regress against); a baseline whose comparison is **incompatible** (§9
 * semantics) ⇒ `fail` with `baseline-incompatible` — a gate that cannot be
 * evaluated never silently passes.
 *
 * Exit-code distinction (SPEC §9): this module returns only success /
 * policy-failure information. Operational errors — an unreadable or invalid
 * baseline artifact — are thrown by `load.ts` before assessment, so the CLI
 * can keep `1` (operational) distinct from `2` (policy tripped) and `0`
 * (clean). CLI/SDK wiring lands with trellis-9a88.
 */
import type { AuditReport, MetricValue, PolicyConfig } from "../contract/index.ts";
import { type CompareOptions, compareReports, type ReportComparison } from "./compare.ts";

/** The policy families {@link assessPolicy} evaluates. */
export type PolicyKind = "max-index" | "metric-budget" | "score-regression" | "new-findings";

/** Machine-readable reason codes (see the module docblock). */
export type PolicyReasonCode =
	| "index-exceeds-max"
	| "budget-exceeded"
	| "budget-metric-unknown"
	| "budget-metric-unevaluable"
	| "regression-exceeds-absolute"
	| "regression-exceeds-relative"
	| "new-finding"
	| "baseline-absent"
	| "baseline-incompatible";

/** A structured policy reason: a stable code plus a human message. */
export interface PolicyReason {
	code: PolicyReasonCode;
	message: string;
}

/** The outcome of one configured policy (or one budget entry / failOnNew kind). */
export interface PolicyResult {
	policy: PolicyKind;
	/** The budgeted metric id or failOnNew finding kind, when applicable. */
	subject?: string;
	status: "pass" | "fail" | "skipped";
	reasons: PolicyReason[];
}

/** The whole assessment: `failed` iff any independently evaluated result failed. */
export interface PolicyAssessment {
	failed: boolean;
	results: PolicyResult[];
}

/** Options for {@link assessPolicy}. */
export interface AssessPolicyOptions {
	/** A saved baseline report artifact (§9); required by baseline-dependent policies. */
	baseline?: AuditReport;
	/** Forwarded to {@link compareReports} for configuration-compatibility checks. */
	compare?: CompareOptions;
}

/** Cap on individually listed finding locations inside one reason message. */
const MAX_LISTED_LOCATIONS = 5;

function assessMaxIndex(report: AuditReport, maxIndex: number): PolicyResult {
	const result: PolicyResult = { policy: "max-index", status: "pass", reasons: [] };
	if (report.score.index > maxIndex) {
		result.status = "fail";
		result.reasons.push({
			code: "index-exceeds-max",
			message: `sloppiness index ${report.score.index} exceeds the configured maximum ${maxIndex} (lower is better)`,
		});
	}
	return result;
}

function assessBudget(report: AuditReport, id: string, max: number): PolicyResult {
	const result: PolicyResult = {
		policy: "metric-budget",
		subject: id,
		status: "pass",
		reasons: [],
	};
	const metric: MetricValue | undefined = report.metrics[id];
	if (metric === undefined) {
		result.status = "fail";
		result.reasons.push({
			code: "budget-metric-unknown",
			message: `budgeted metric "${id}" is absent from the report — check the budget configuration`,
		});
		return result;
	}
	if (metric.value === undefined) {
		result.status = "skipped";
		result.reasons.push({
			code: "budget-metric-unevaluable",
			message: `budgeted metric "${id}" is ${metric.state} and carries no value to compare against max ${max}`,
		});
		return result;
	}
	if (metric.value > max) {
		result.status = "fail";
		result.reasons.push({
			code: "budget-exceeded",
			message: `metric "${id}" is ${metric.value} ${metric.unit}, over the budgeted max ${max}`,
		});
	}
	return result;
}

/** Resolve the baseline comparison, or the skip/fail result that replaces baseline-dependent policies. */
function resolveComparison(
	report: AuditReport,
	options: AssessPolicyOptions,
): { comparison: ReportComparison } | { blocker: PolicyResult } {
	if (options.baseline === undefined) {
		return {
			blocker: {
				policy: "score-regression",
				status: "skipped",
				reasons: [
					{
						code: "baseline-absent",
						message: "no baseline report supplied: the policy was not evaluated",
					},
				],
			},
		};
	}
	const comparison = compareReports(options.baseline, report, options.compare);
	if (!comparison.compatibility.comparable) {
		const details = comparison.compatibility.issues.map((issue) => issue.message).join("; ");
		return {
			blocker: {
				policy: "score-regression",
				status: "fail",
				reasons: [
					{
						code: "baseline-incompatible",
						message: `the baseline report is not comparable: ${details}`,
					},
				],
			},
		};
	}
	return { comparison };
}

function assessRegression(
	regression: NonNullable<PolicyConfig["regression"]>,
	comparison: ReportComparison,
): PolicyResult {
	const result: PolicyResult = { policy: "score-regression", status: "pass", reasons: [] };
	const score = comparison.score;
	if (score === undefined) return result; // unreachable: comparable comparisons carry a score delta
	const increase = score.delta;
	if (increase <= 0) return result; // an equal or better index never regresses
	if (regression.maxIncrease !== undefined && increase > regression.maxIncrease) {
		result.status = "fail";
		result.reasons.push({
			code: "regression-exceeds-absolute",
			message: `index rose ${increase} points (${score.baseline} → ${score.current}), over the absolute tolerance ${regression.maxIncrease}`,
		});
	}
	if (regression.maxIncreasePercent !== undefined) {
		const bound = (score.baseline * regression.maxIncreasePercent) / 100;
		if (increase > bound) {
			result.status = "fail";
			result.reasons.push({
				code: "regression-exceeds-relative",
				message: `index rose ${increase} points (${score.baseline} → ${score.current}), over the relative tolerance ${regression.maxIncreasePercent}% of the baseline (${bound})`,
			});
		}
	}
	if (regression.maxIncrease === undefined && regression.maxIncreasePercent === undefined) {
		result.status = "fail";
		result.reasons.push({
			code: "regression-exceeds-absolute",
			message: `index rose ${increase} points (${score.baseline} → ${score.current}) with zero configured tolerance`,
		});
	}
	return result;
}

function assessNewFindings(kind: string, comparison: ReportComparison): PolicyResult {
	const result: PolicyResult = {
		policy: "new-findings",
		subject: kind,
		status: "pass",
		reasons: [],
	};
	const found = (comparison.findings?.new ?? []).filter((finding) => finding.kind === kind);
	if (found.length > 0) {
		const locations = found
			.slice(0, MAX_LISTED_LOCATIONS)
			.map((finding) => `${finding.path}:${finding.range.start.line}`);
		const rest = found.length - locations.length;
		result.status = "fail";
		result.reasons.push({
			code: "new-finding",
			message: `${found.length} new "${kind}" finding(s) vs the baseline: ${locations.join(", ")}${rest > 0 ? ` (+${rest} more)` : ""}`,
		});
	}
	return result;
}

/** Every configured metric budget, in sorted metric-id order (deterministic). */
function assessBudgets(report: AuditReport, policy: PolicyConfig): PolicyResult[] {
	const results: PolicyResult[] = [];
	for (const id of Object.keys(policy.budgets).sort()) {
		const budget = policy.budgets[id];
		if (budget !== undefined) results.push(assessBudget(report, id, budget.max));
	}
	return results;
}

/** The baseline-dependent policies: score regression and failOnNew kinds. */
function assessBaselinePolicies(
	report: AuditReport,
	policy: PolicyConfig,
	options: AssessPolicyOptions,
): PolicyResult[] {
	if (policy.regression === undefined && policy.failOnNew.length === 0) return [];
	const resolved = resolveComparison(report, options);
	const results: PolicyResult[] = [];
	if (policy.regression !== undefined) {
		results.push(
			"blocker" in resolved
				? resolved.blocker
				: assessRegression(policy.regression, resolved.comparison),
		);
	}
	for (const kind of policy.failOnNew) {
		results.push(
			"blocker" in resolved
				? { ...resolved.blocker, policy: "new-findings", subject: kind }
				: assessNewFindings(kind, resolved.comparison),
		);
	}
	return results;
}

/**
 * Evaluate every configured policy against the current report (see the module
 * docblock). Pure: no I/O; operational errors surface from artifact loading,
 * never from here.
 */
export function assessPolicy(
	report: AuditReport,
	policy: PolicyConfig,
	options: AssessPolicyOptions = {},
): PolicyAssessment {
	const results: PolicyResult[] = [];
	if (policy.maxIndex !== undefined) results.push(assessMaxIndex(report, policy.maxIndex));
	results.push(...assessBudgets(report, policy));
	results.push(...assessBaselinePolicies(report, policy, options));
	return { failed: results.some((result) => result.status === "fail"), results };
}
