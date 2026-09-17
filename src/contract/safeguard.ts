/**
 * Safeguard result contract (SPEC §5.5, §6.3).
 *
 * A safeguard result is configuration evidence about a hook or check —
 * never a metric, and it contributes nothing to the sloppiness index in
 * either direction (§3.2, §5.5). Evidence levels:
 *
 * - `absent` — no configuration surface found (must carry no locations).
 * - `configured` — configuration exists (must carry at least one location).
 * - `structurally-wired` — configuration is verifiably connected to an
 *   enforcement point (must carry at least one location).
 * - `unknown` — the surface uses unsupported constructs (arbitrary shell,
 *   executable config) — explicitly unverified; locations optional.
 *
 * Passing execution is never inferred (§5.5): this schema cannot express a
 * "passing" state at all.
 */
import { z } from "zod";
import { rangeSchema } from "./finding.ts";
import { dottedIdSchema, relativePathSchema } from "./primitives.ts";

export const EVIDENCE_LEVELS = ["absent", "configured", "structurally-wired", "unknown"] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

/** Where the configuration evidence was found; `range` when it is a located reference. */
export const safeguardLocationSchema = z.strictObject({
	path: relativePathSchema,
	range: rangeSchema.optional(),
});

export type SafeguardLocation = z.infer<typeof safeguardLocationSchema>;

export const safeguardResultSchema = z
	.strictObject({
		id: dottedIdSchema,
		evidence: z.enum(EVIDENCE_LEVELS),
		locations: z.array(safeguardLocationSchema),
		notes: z.string().min(1).optional(),
	})
	.superRefine((result, ctx) => {
		if (result.evidence === "absent" && result.locations.length > 0) {
			ctx.addIssue({
				code: "custom",
				message: "an absent safeguard carries no locations",
				path: ["locations"],
			});
		}
		if (
			(result.evidence === "configured" || result.evidence === "structurally-wired") &&
			result.locations.length === 0
		) {
			ctx.addIssue({
				code: "custom",
				message: `a ${result.evidence} safeguard must point at its configuration surface`,
				path: ["locations"],
			});
		}
	});

export type SafeguardResult = z.infer<typeof safeguardResultSchema>;
