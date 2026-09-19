/** Additive native clone facts v1; absence in older reports means unknown. */
import { z } from "zod";
import { relativePathSchema } from "./primitives.ts";

const spanSchema = z
	.strictObject({
		path: relativePathSchema,
		startLine: z.number().int().positive(),
		endLine: z.number().int().positive(),
	})
	.refine((span) => span.endLine >= span.startLine, "invalid line span");

export const lineOverlapSchema = z
	.strictObject({
		version: z.literal(1),
		overlaps: z.boolean(),
		/** Zero-based indexes into this finding's facts.members, retaining every occurrence. */
		memberIndexes: z.array(z.number().int().nonnegative()),
		/** Union of inclusive line spans covered by at least two members in the same file. */
		spans: z.array(spanSchema),
	})
	.refine(
		(value) =>
			value.overlaps
				? value.memberIndexes.length >= 2 && value.spans.length > 0
				: value.memberIndexes.length === 0 && value.spans.length === 0,
		"overlap flag must agree with affected members and spans",
	);

export type LineOverlap = z.infer<typeof lineOverlapSchema>;
