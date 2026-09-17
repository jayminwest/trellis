/**
 * Finding contract (SPEC §6.2).
 *
 * A finding is a located piece of evidence: a repo-relative path and a line
 * range, plus a stable, versioned kind (hotspot function, clone group, cycle
 * group, broken hook reference, …). Producers order findings deterministically
 * (§3.2); the schema guarantees each finding is well-located and its range
 * is valid (end never precedes start).
 */
import { z } from "zod";
import { dottedIdSchema, relativePathSchema } from "./primitives.ts";

/** A source position: 1-based line, optional 1-based column. */
export const positionSchema = z.strictObject({
	line: z.number().int().min(1),
	column: z.number().int().min(1).optional(),
});

export type Position = z.infer<typeof positionSchema>;

/** A half-open-friendly line range; `end` never precedes `start`. */
export const rangeSchema = z
	.strictObject({
		start: positionSchema,
		end: positionSchema,
	})
	.superRefine((range, ctx) => {
		if (range.end.line < range.start.line) {
			ctx.addIssue({
				code: "custom",
				message: "range end must not precede range start",
				path: ["end"],
			});
			return;
		}
		if (
			range.end.line === range.start.line &&
			range.start.column !== undefined &&
			range.end.column !== undefined &&
			range.end.column < range.start.column
		) {
			ctx.addIssue({
				code: "custom",
				message: "range end column must not precede start column on the same line",
				path: ["end", "column"],
			});
		}
	});

export type Range = z.infer<typeof rangeSchema>;

export const findingSchema = z.strictObject({
	kind: dottedIdSchema,
	path: relativePathSchema,
	range: rangeSchema,
	summary: z.string().min(1),
	facts: z.record(z.string(), z.unknown()).optional(),
});

export type Finding = z.infer<typeof findingSchema>;
