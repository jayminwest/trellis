/**
 * Scorecard entry (SPEC §6.2) — the per-criterion, per-run unit the scorer folds
 * over. One entry carries the criterion's numerator/denominator, a human
 * rationale, and (only when N/A) the `naKind` that decides whether it drags
 * coverage down or is excluded entirely.
 *
 * `numerator` is `null` exactly when the criterion is N/A; `naKind` is present
 * exactly then. The zod schema enforces that biconditional and the ≤500-char
 * rationale cap so malformed entries fail loudly at the boundary.
 */
import { z } from "zod";

/** The two N/A flavours (SPEC §3.2). Only ever set when `numerator` is null. */
export const NA_KINDS = ["not-applicable", "no-detector"] as const;
export type NaKind = (typeof NA_KINDS)[number];

/** Rationale character cap (SPEC §6.2). */
export const MAX_RATIONALE = 500;

/**
 * One scorecard entry. Mirrors the SPEC §6.2 JSON shape exactly:
 * - `numerator` — repo: `1|0`; app: count of passing apps; `null` = N/A.
 * - `denominator` — repo: always `1`; app: `N` discovered apps.
 * - `rationale` — ≤500 chars, why it passed / failed / was N/A.
 * - `naKind` — present **iff** `numerator` is null.
 */
export interface ScorecardEntry {
	numerator: number | null;
	denominator: number;
	rationale: string;
	naKind?: NaKind;
}

/** zod schema enforcing the §6.2 invariants (numerator/naKind biconditional, ≤denominator, ≤500-char rationale). */
export const scorecardEntrySchema = z
	.strictObject({
		numerator: z.number().int().nonnegative().nullable(),
		denominator: z.number().int().positive(),
		rationale: z.string().min(1).max(MAX_RATIONALE),
		naKind: z.enum(NA_KINDS).optional(),
	})
	.superRefine((entry, ctx) => {
		if (entry.numerator === null && entry.naKind === undefined) {
			ctx.addIssue({
				code: "custom",
				message: "naKind is required when numerator is null (N/A)",
				path: ["naKind"],
			});
		}
		if (entry.numerator !== null && entry.naKind !== undefined) {
			ctx.addIssue({
				code: "custom",
				message: "naKind must be absent when numerator is non-null",
				path: ["naKind"],
			});
		}
		if (entry.numerator !== null && entry.numerator > entry.denominator) {
			ctx.addIssue({
				code: "custom",
				message: "numerator must not exceed denominator",
				path: ["numerator"],
			});
		}
	});

/**
 * How an entry contributes to scoring (SPEC §3.2):
 * - `counted` — a real measurement; feeds pass-rate and coverage.
 * - `no-detector` — should have been measured but wasn't; **counted against** coverage.
 * - `not-applicable` — honestly absent; **excluded** from the coverage base.
 */
export type Disposition = "counted" | "no-detector" | "not-applicable";

/** Classify an entry into its scoring disposition. */
export function disposition(entry: ScorecardEntry): Disposition {
	if (entry.numerator !== null) return "counted";
	return entry.naKind === "not-applicable" ? "not-applicable" : "no-detector";
}

/**
 * Per-criterion score: `numerator / denominator`, or `null` when N/A (SPEC §3.4).
 * N/A entries return null and are excluded by the caller from the pass-rate mean.
 */
export function perCriterionScore(entry: ScorecardEntry): number | null {
	return entry.numerator === null ? null : entry.numerator / entry.denominator;
}
