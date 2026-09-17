/**
 * Audit configuration contract (SPEC §6.5) — declarative data, never code.
 *
 * Per-repo configuration (`trellis.yaml`, optional; sensible defaults without
 * it) describes source exclusions/classification and the failure policy. It
 * contains **no executable hooks**: the schema is pure data (strings, numbers,
 * lists, maps), and strict objects reject any unknown key — including any
 * attempt to smuggle in hook commands or to override scoring weights. Policy
 * budgets gate the run (§9); they never mutate how the index is computed (§7).
 *
 * Loading/discovery of the config file itself lives in `src/config/load.ts`
 * (trellis-6003); this module defines only the contract.
 */
import { z } from "zod";
import { SOURCE_SETS } from "./coverage.ts";
import { dottedIdSchema, finiteNumberSchema } from "./primitives.ts";
import { EVIDENCE_NAMESPACE, NATIVE_NAMESPACE } from "./provider.ts";

/**
 * Source handling: `exclude` adds glob exclusions to the documented defaults;
 * `classify` maps globs to explicit source-set overrides (SPEC §3.1, §6.5).
 */
export const sourceConfigSchema = z.strictObject({
	exclude: z.array(z.string().min(1)).default([]),
	classify: z.record(z.string().min(1), z.enum(SOURCE_SETS)).default({}),
});

export type SourceConfig = z.infer<typeof sourceConfigSchema>;

/** A metric budget: the run fails when the measured value exceeds `max`. */
export const metricBudgetSchema = z.strictObject({
	max: finiteNumberSchema.nonnegative(),
});

export type MetricBudget = z.infer<typeof metricBudgetSchema>;

/**
 * Score-regression tolerance against a baseline report (SPEC §9). The two
 * knobs are independent bounds, documented by kind:
 *
 * - `maxIncrease` — **absolute** tolerance in index points (0–100 scale):
 *   the run fails when `current.index - baseline.index` exceeds it.
 * - `maxIncreasePercent` — **relative** tolerance as a percentage of the
 *   baseline index: the run fails when the increase exceeds
 *   `baseline.index × maxIncreasePercent / 100`.
 *
 * When both are set, exceeding either bound fails. A `regression` block with
 * neither knob tolerates zero increase. Evaluation lives in
 * `src/compare/policy.ts` (trellis-942c).
 */
export const regressionPolicySchema = z.strictObject({
	maxIncrease: finiteNumberSchema.min(0).max(100).optional(),
	maxIncreasePercent: finiteNumberSchema.min(0).optional(),
});

export type RegressionPolicy = z.infer<typeof regressionPolicySchema>;

/**
 * A required optional-provider analysis id (SPEC §16.3 — plan `pl-43c5` step 7,
 * trellis-68b9). `requireEvidence` *demands* provider evidence: a required
 * analysis that is unrequested, unavailable, unsupported or incomplete fails
 * the policy closed (exit `2`, report still emitted) even when the native
 * score is complete and clean — while an absent optional provider with no
 * requirement never violates policy and never touches the score (§16.5).
 *
 * The values are **supported analysis ids** — the external provider ids of the
 * supported-provider capability table (`src/providers/capabilities.ts`). Two
 * near-miss vocabularies are rejected here, at parse time, as actionable
 * configuration errors (operational exit `1`, SPEC §16.3):
 *
 * - native analyzer ids (`trellis.*`) — native analyzers always run; their
 *   gaps are governed by metric budgets and the score's own completeness,
 *   never by evidence requirements;
 * - namespaced evidence ids (`provider.<id>.<metric>`) — those name a
 *   provider's *evidence*, not the analysis itself; `budgets` is the surface
 *   that consumes them.
 *
 * A requirement is declarative data only: it never selects scoring weights,
 * never executes a provider implicitly, and accepts no command strings.
 */
const requiredAnalysisIdSchema = dottedIdSchema.superRefine((id, ctx) => {
	if (id === NATIVE_NAMESPACE || id.startsWith(`${NATIVE_NAMESPACE}.`)) {
		ctx.addIssue({
			code: "custom",
			message:
				"policy requirements demand optional provider evidence — native analyzers always run and are governed by metric budgets, never by requireEvidence",
		});
	}
	if (id.startsWith(`${EVIDENCE_NAMESPACE}.`)) {
		ctx.addIssue({
			code: "custom",
			message:
				'policy requirements name an analysis id ("jscpd"), not a namespaced evidence id ("provider.jscpd.pairs") — budgets consume evidence ids',
		});
	}
});

/**
 * Failure policy only — never mutates scoring weights (SPEC §6.5, §7).
 * `failOnNew` lists finding kinds whose appearance relative to a baseline
 * fails the run (§9). `budgets` may name native metric ids or a provider's
 * namespaced evidence ids (`provider.<id>.<metric>`, evaluated only over that
 * analysis's carried evidence); `requireEvidence` lists the optional provider
 * analyses whose evidence the policy demands (§16.3).
 */
export const policyConfigSchema = z.strictObject({
	maxIndex: finiteNumberSchema.min(0).max(100).optional(),
	regression: regressionPolicySchema.optional(),
	budgets: z.record(dottedIdSchema, metricBudgetSchema).default({}),
	failOnNew: z.array(dottedIdSchema).default([]),
	requireEvidence: z.array(requiredAnalysisIdSchema).default([]),
});

export type PolicyConfig = z.infer<typeof policyConfigSchema>;

export const auditConfigSchema = z.strictObject({
	source: sourceConfigSchema.prefault({}),
	policy: policyConfigSchema.prefault({}),
});

export type AuditConfig = z.infer<typeof auditConfigSchema>;
