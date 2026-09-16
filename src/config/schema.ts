/**
 * Audit configuration contract (SPEC §6.5) — per-repo configuration as data,
 * not code. The schema is the whole surface: source exclusions and
 * classification overrides, plus a failure policy. There are **no executable
 * hooks** — unknown keys (including any hook/script/runner shape) are
 * rejected, and policy budgets gate the run without ever mutating how the
 * index is computed (SPEC §7).
 *
 * Range invariant: a budget with both `min` and `max` must have
 * `min ≤ max`, and a budget with neither is empty noise — both are rejected
 * as invalid ranges (SPEC §6).
 */
import { z } from "zod";
import { sourceSetSchema } from "../contracts/index.ts";

/** A per-metric failure budget (SPEC §6.5) — gates the run, never re-weights. */
export const metricBudgetSchema = z
	.strictObject({
		/** Fail when the metric exceeds this value. */
		max: z.number().finite().optional(),
		/** Fail when the metric falls below this value. */
		min: z.number().finite().optional(),
	})
	.superRefine((budget, ctx) => {
		if (budget.max === undefined && budget.min === undefined) {
			ctx.addIssue({
				code: "custom",
				message: "a budget must declare at least one of min or max",
			});
		}
		if (
			budget.max !== undefined &&
			budget.min !== undefined &&
			budget.min > budget.max
		) {
			ctx.addIssue({
				code: "custom",
				message: "budget min must not exceed budget max",
				path: ["min"],
			});
		}
	});

export type MetricBudget = z.infer<typeof metricBudgetSchema>;

/** Source discovery configuration (SPEC §3.1, §6.5). */
export const sourceConfigSchema = z.strictObject({
	/** Glob additions to the documented default exclusions. */
	exclude: z.array(z.string().min(1)).default([]),
	/** Explicit per-glob source-set overrides (e.g. `"scripts/tools/**": test`). */
	classify: z.record(z.string().min(1), sourceSetSchema).default({}),
});

export type SourceConfig = z.infer<typeof sourceConfigSchema>;

/** Failure policy configuration (SPEC §6.5, §9) — never mutates scoring. */
export const policyConfigSchema = z.strictObject({
	/** Fail when the sloppiness index exceeds this threshold (0–100). */
	maxIndex: z.number().finite().min(0).max(100).optional(),
	/** Per-metric budgets, keyed by metric id. */
	budgets: z.record(z.string().min(1), metricBudgetSchema).default({}),
	/** Finding kinds that fail the run when they appear as new (SPEC §9). */
	failOnNew: z.array(z.string().min(1)).default([]),
});

export type PolicyConfig = z.infer<typeof policyConfigSchema>;

/** The declarative audit configuration (SPEC §6.5). All sections optional. */
export const auditConfigSchema = z.strictObject({
	source: sourceConfigSchema.default({ exclude: [], classify: {} }),
	policy: policyConfigSchema.default({ budgets: {}, failOnNew: [] }),
});

export type AuditConfig = z.infer<typeof auditConfigSchema>;

/** Validate unknown data as an {@link AuditConfig}; throws `ZodError`. */
export function parseAuditConfig(data: unknown): AuditConfig {
	return auditConfigSchema.parse(data);
}
