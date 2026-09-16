/**
 * Metric value contract (SPEC §6.1) — one deterministic numeric measurement
 * with a unit and, where meaningful, a numerator/denominator pair. Raw metric
 * values live here; score contributions are a separate report structure
 * (SPEC §6.4), so a raw measurement is never conflated with the points it
 * produces.
 *
 * Cross-field invariants (enforced by {@link metricValueSchema}):
 *   1. `value` is always finite — NaN and ±Infinity are rejected outright;
 *   2. a `complete` state must carry a value — an apparently complete
 *      measurement with nothing measured is a misleading state (SPEC §6);
 *   3. an `incomplete` state must carry a `reason` — the report says what
 *      could not be analyzed (SPEC §3.3);
 *   4. `numerator`/`denominator` arrive as a pair or not at all, and the
 *      numerator never exceeds its denominator (they express a ratio).
 */
import { z } from "zod";
import { analysisStateSchema } from "./states.ts";

/** One deterministic numeric measurement (SPEC §6.1). */
export const metricValueSchema = z
	.strictObject({
		/** Stable metric id from the §5 catalog (e.g. `duplication.density`). */
		id: z.string().min(1),
		/** Analysis state of this measurement (SPEC §3.3). */
		state: analysisStateSchema,
		/** The measured value; finite only. Required when `state` is `complete`. */
		value: z.number().finite().optional(),
		/** Unit of `value`, per the metric catalog (e.g. `ratio`, `count`, `sloc`). */
		unit: z.string().min(1),
		/** Optional raw numerator (e.g. unique duplicated lines). */
		numerator: z.number().int().nonnegative().optional(),
		/** Optional raw denominator (e.g. analyzed lines). */
		denominator: z.number().int().nonnegative().optional(),
		/** Why the scope could not be fully analyzed; required when `incomplete`. */
		reason: z.string().min(1).optional(),
		/** Per-metric extras (distributions, group counts, …). */
		detail: z.record(z.string(), z.unknown()).optional(),
	})
	.superRefine((metric, ctx) => {
		if (metric.state === "complete" && metric.value === undefined) {
			ctx.addIssue({
				code: "custom",
				message: "a complete measurement must carry a value",
				path: ["value"],
			});
		}
		if (metric.state === "incomplete" && metric.reason === undefined) {
			ctx.addIssue({
				code: "custom",
				message: "an incomplete measurement must carry a reason",
				path: ["reason"],
			});
		}
		const hasNumerator = metric.numerator !== undefined;
		const hasDenominator = metric.denominator !== undefined;
		if (hasNumerator !== hasDenominator) {
			ctx.addIssue({
				code: "custom",
				message: "numerator and denominator must arrive as a pair",
				path: [hasNumerator ? "denominator" : "numerator"],
			});
		}
		if (
			hasNumerator &&
			hasDenominator &&
			(metric.numerator as number) > (metric.denominator as number)
		) {
			ctx.addIssue({
				code: "custom",
				message: "numerator must not exceed denominator",
				path: ["numerator"],
			});
		}
	});

export type MetricValue = z.infer<typeof metricValueSchema>;
