/**
 * Source coverage contract (SPEC §3.1, §6.4) — how much source exists in each
 * source set, kept strictly separate from analysis completeness (SPEC §3.3).
 * Coverage answers "how much source is there, of what kind?"; completeness
 * answers "how much of the intended scope was actually measured?". The two
 * are never conflated.
 *
 * Only `production` and `test` sets are scored, and they are scored
 * separately — test code never offsets production debt. `generated`,
 * `vendored`, `declaration-only`, `excluded`, and `unsupported` surface is
 * reported as coverage, never counted as clean (SPEC §3.1, §3.3).
 */
import { z } from "zod";

/** The five scoring-relevant source sets (SPEC §3.1). */
export const SOURCE_SETS = [
	"production",
	"test",
	"generated",
	"vendored",
	"declaration-only",
] as const;

/** One source set a discovered file is classified into (SPEC §3.1). */
export type SourceSet = (typeof SOURCE_SETS)[number];

/** zod schema for a {@link SourceSet} — reused by the audit configuration. */
export const sourceSetSchema = z.enum(SOURCE_SETS);

/** Coverage of one source set (or of the unsupported/excluded surface). */
export const setCoverageSchema = z.strictObject({
	/** Files in the set. */
	files: z.number().int().nonnegative(),
	/** Source lines in the set, when measured. */
	sloc: z.number().int().nonnegative().optional(),
	/** Free-form context (e.g. "non-TS sources, not analyzed"). */
	note: z.string().optional(),
});

export type SetCoverage = z.infer<typeof setCoverageSchema>;

/**
 * The report's §6.4 `sourceCoverage` map. `production` and `test` are always
 * reported (they are the scored sets); the remaining sets appear when the
 * workspace has such surface.
 */
export const sourceCoverageSchema = z.strictObject({
	production: setCoverageSchema,
	test: setCoverageSchema,
	generated: setCoverageSchema.optional(),
	vendored: setCoverageSchema.optional(),
	"declaration-only": setCoverageSchema.optional(),
	/** Non-TS/TSX surface — coverage, never cleanliness (SPEC §3.3). */
	unsupported: setCoverageSchema.optional(),
	/** Surface excluded by configuration (SPEC §6.5) — reported, not clean. */
	excluded: setCoverageSchema.optional(),
});

export type SourceCoverage = z.infer<typeof sourceCoverageSchema>;
