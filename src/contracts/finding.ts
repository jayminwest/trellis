/**
 * Finding contract (SPEC §6.2) — one located piece of evidence: a
 * repo-relative path and a line range, plus a stable kind. Findings are
 * ordered deterministically by their producers (stable across filesystem
 * enumeration order); the contract fixes the shape, not the ordering.
 *
 * Range invariants (enforced by {@link findingRangeSchema}): lines are
 * 1-based, and the end never precedes the start — an inverted or zero-line
 * range is an invalid range and is rejected (SPEC §6).
 */
import { z } from "zod";

/**
 * A repo-relative path. Absolute paths and parent-escaping segments are
 * rejected: findings locate evidence inside the audited tree, and consumers
 * join paths against the repo root without re-validating.
 */
export const relativePathSchema = z
	.string()
	.min(1)
	.refine((p) => !p.startsWith("/") && !/^[A-Za-z]:/.test(p), {
		message: "must be a repo-relative path, not absolute",
	})
	.refine((p) => !p.split("/").includes(".."), {
		message: "must not escape the repo root",
	});

/** A 1-based source position. */
export const positionSchema = z.strictObject({
	line: z.number().int().min(1),
	column: z.number().int().min(1).optional(),
});

export type Position = z.infer<typeof positionSchema>;

/** A line range within one file; `end` never precedes `start`. */
export const findingRangeSchema = z
	.strictObject({
		start: positionSchema,
		end: positionSchema,
	})
	.superRefine((range, ctx) => {
		if (range.end.line < range.start.line) {
			ctx.addIssue({
				code: "custom",
				message: "range end must not precede its start",
				path: ["end"],
			});
			return;
		}
		const { start, end } = range;
		if (
			start.line === end.line &&
			start.column !== undefined &&
			end.column !== undefined &&
			end.column < start.column
		) {
			ctx.addIssue({
				code: "custom",
				message: "range end column must not precede its start column on the same line",
				path: ["end"],
			});
		}
	});

export type FindingRange = z.infer<typeof findingRangeSchema>;

/** One located piece of evidence (SPEC §6.2). */
export const findingSchema = z.strictObject({
	/** Stable, versioned finding kind (e.g. `complexity.hotspot`, `import-cycle`). */
	kind: z.string().min(1),
	/** Repo-relative path of the evidence. */
	path: relativePathSchema,
	/** Line range of the evidence within `path`. */
	range: findingRangeSchema,
	/** One-line human summary (e.g. `CC 23, mass 214`). */
	summary: z.string().min(1),
	/** Structured facts behind the summary, for downstream policy and rendering. */
	facts: z.record(z.string(), z.unknown()).optional(),
});

export type Finding = z.infer<typeof findingSchema>;
