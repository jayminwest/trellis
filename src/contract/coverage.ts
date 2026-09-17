/**
 * Source coverage contract (SPEC §3.1, §3.3, §6.4).
 *
 * Every discovered file belongs to exactly one source set. Only `production`
 * and `test` are scored, and they are scored separately; `generated`,
 * `vendored`, `excluded`, and `unsupported` surface are reported as coverage,
 * never counted as clean.
 *
 * Source coverage (how much source of each kind exists — including how much
 * *test* source exists) is a distinct field from analysis completeness (how
 * much of the intended scope was actually measured, SPEC §3.3); the two are
 * never conflated.
 */
import { z } from "zod";

/** Source sets assigned by discovery & classification (SPEC §3.1). */
export const SOURCE_SETS = [
	"production",
	"test",
	"generated",
	"vendored",
	"declaration-only",
] as const;
export type SourceSet = (typeof SOURCE_SETS)[number];

/** Coverage scopes reported on a report: the source sets plus the non-source surface. */
export const COVERAGE_SCOPES = [...SOURCE_SETS, "excluded", "unsupported"] as const;
export type CoverageScope = (typeof COVERAGE_SCOPES)[number];

export const sourceCoverageEntrySchema = z.strictObject({
	files: z.number().int().nonnegative(),
	sloc: z.number().int().nonnegative().optional(),
	note: z.string().min(1).optional(),
});

export type SourceCoverageEntry = z.infer<typeof sourceCoverageEntrySchema>;

/**
 * Per-scope coverage on a report. `production` and `test` are always present
 * (they are the scored scopes); the remaining scopes appear when non-empty.
 */
export const sourceCoverageSchema = z.strictObject({
	production: sourceCoverageEntrySchema,
	test: sourceCoverageEntrySchema,
	generated: sourceCoverageEntrySchema.optional(),
	vendored: sourceCoverageEntrySchema.optional(),
	"declaration-only": sourceCoverageEntrySchema.optional(),
	excluded: sourceCoverageEntrySchema.optional(),
	unsupported: sourceCoverageEntrySchema.optional(),
});

export type SourceCoverage = z.infer<typeof sourceCoverageSchema>;
