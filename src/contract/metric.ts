/**
 * Metric value contract (SPEC §6.1).
 *
 * A metric is a deterministic numeric measurement with a unit and, where
 * meaningful, a numerator/denominator pair (e.g. duplicated lines / analyzed
 * lines). Raw metrics are reported separately from their score contributions
 * (SPEC §3.2) — this schema carries only the raw measurement; scoring
 * contributions live on the report's `score` (§6.4).
 *
 * State invariants (SPEC §3.3, §6 intro — no misleading `complete` states):
 *
 * - `complete` must carry a finite `value` and no `reason`.
 * - `incomplete` must carry a `reason` (what could not be analyzed, §3.3);
 *   a partial `value` is allowed but never required.
 * - `unsupported` / `not-applicable` must not carry a `value` — the
 *   measurement did not happen, so there is nothing to show.
 */
import { z } from "zod";
import { dottedIdSchema, finiteNumberSchema } from "./primitives.ts";
import { analysisStateSchema } from "./states.ts";

export const metricValueSchema = z
	.strictObject({
		id: dottedIdSchema,
		state: analysisStateSchema,
		value: finiteNumberSchema.optional(),
		unit: z.string().min(1),
		numerator: finiteNumberSchema.nonnegative().optional(),
		denominator: finiteNumberSchema.positive().optional(),
		reason: z.string().min(1).optional(),
		detail: z.record(z.string(), z.unknown()).optional(),
	})
	.superRefine((metric, ctx) => {
		if (metric.state === "complete" && metric.value === undefined) {
			ctx.addIssue({
				code: "custom",
				message: "a complete metric must carry a finite value",
				path: ["value"],
			});
		}
		if (
			(metric.state === "unsupported" || metric.state === "not-applicable") &&
			metric.value !== undefined
		) {
			ctx.addIssue({
				code: "custom",
				message: `a ${metric.state} metric must not carry a value`,
				path: ["value"],
			});
		}
		if (metric.state === "incomplete" && metric.reason === undefined) {
			ctx.addIssue({
				code: "custom",
				message: "an incomplete metric must carry a reason (what could not be analyzed)",
				path: ["reason"],
			});
		}
		if (metric.state !== "incomplete" && metric.reason !== undefined) {
			ctx.addIssue({
				code: "custom",
				message: "reason is only meaningful on an incomplete metric",
				path: ["reason"],
			});
		}
		if ((metric.numerator === undefined) !== (metric.denominator === undefined)) {
			ctx.addIssue({
				code: "custom",
				message: "numerator/denominator are a pair: both present or both absent",
				path: ["denominator"],
			});
		}
	});

export type MetricValue = z.infer<typeof metricValueSchema>;
