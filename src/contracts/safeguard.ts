/**
 * Safeguard result contract (SPEC §6.3) — configuration evidence about one
 * hook or check. Safeguards are **not** metrics: they never enter the
 * sloppiness index in either direction (SPEC §5.5), so this shape lives
 * beside the metric contract, not inside it.
 *
 * Evidence levels (SPEC §5.5):
 *   - `absent`              — no configuration surface found;
 *   - `configured`          — configuration exists;
 *   - `structurally-wired`  — configuration is verifiably connected to an
 *                             enforcement point (e.g. a CI step invoking the
 *                             check script);
 *   - `unknown`             — the surface uses unsupported constructs
 *                             (arbitrary shell, executable config) and is
 *                             explicitly unverified — never guessed.
 *
 * Passing execution is never inferred: a safeguard reports that a check is
 * wired, not that it succeeds.
 */
import { z } from "zod";
import { findingRangeSchema, relativePathSchema } from "./finding.ts";

/** The four safeguard evidence levels (SPEC §5.5), in escalating order. */
export const EVIDENCE_LEVELS = ["absent", "configured", "structurally-wired", "unknown"] as const;

/** One safeguard evidence level (SPEC §5.5). */
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

/** A configuration surface location backing a safeguard result. */
export const safeguardLocationSchema = z.strictObject({
	/** Repo-relative path of the configuration surface. */
	path: relativePathSchema,
	/** Optional line range pinpointing the evidence within `path`. */
	range: findingRangeSchema.optional(),
});

export type SafeguardLocation = z.infer<typeof safeguardLocationSchema>;

/** Configuration evidence for one hook or check (SPEC §6.3). */
export const safeguardResultSchema = z.strictObject({
	/** Stable safeguard id (e.g. `pre-commit-hook`). */
	id: z.string().min(1),
	/** The evidence level reached (SPEC §5.5). */
	evidence: z.enum(EVIDENCE_LEVELS),
	/** Where the evidence was found; empty when `evidence` is `absent`. */
	locations: z.array(safeguardLocationSchema),
	/** Free-form context (e.g. "invoked via core.hooksPath"). */
	notes: z.string().optional(),
});

export type SafeguardResult = z.infer<typeof safeguardResultSchema>;
