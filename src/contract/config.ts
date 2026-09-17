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
 * Failure policy only — never mutates scoring weights (SPEC §6.5, §7).
 * `failOnNew` lists finding kinds whose appearance relative to a baseline
 * fails the run (§9).
 */
export const policyConfigSchema = z.strictObject({
	maxIndex: finiteNumberSchema.min(0).max(100).optional(),
	regression: regressionPolicySchema.optional(),
	budgets: z.record(dottedIdSchema, metricBudgetSchema).default({}),
	failOnNew: z.array(dottedIdSchema).default([]),
});

export type PolicyConfig = z.infer<typeof policyConfigSchema>;

export const auditConfigSchema = z.strictObject({
	source: sourceConfigSchema.prefault({}),
	policy: policyConfigSchema.prefault({}),
});

export type AuditConfig = z.infer<typeof auditConfigSchema>;
