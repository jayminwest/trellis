/**
 * Clone evidence contract (SPEC §16.5, trellis-90d6; research:
 * docs/research/provider-spike.md).
 *
 * Duplication evidence comes in two distinct units that are declared
 * without ever being equated (AC3):
 *
 * - a **pair** — exactly two locations that matched (jscpd reports pairs);
 * - a **group** — one content-identical run shared by two or more members
 *   (the native detector reports groups).
 *
 * Pairs and groups are different units with different semantics (token vs.
 * literal normalization, similarity thresholds): they are never summed,
 * merged, or converted into one another implicitly — a provider's pair
 * counts and the native group counts stay separate evidence.
 *
 * Near-match similarity is **nontransitive** (plan pl-43c5 risk: connected
 * components over near matches do not form safe equivalence groups), so
 * `near` evidence is pair-only — a group structurally cannot carry it.
 */
import { z } from "zod";
import { rangeSchema } from "./finding.ts";
import { relativePathSchema } from "./primitives.ts";

/** Match modes (research: jscpd exact / normalized / near passes). */
export const CLONE_MATCH_MODES = ["exact", "normalized", "near"] as const;
export type CloneMatchMode = (typeof CLONE_MATCH_MODES)[number];
export const cloneMatchModeSchema = z.enum(CLONE_MATCH_MODES);

/** A clone evidence location: repo-relative path plus a valid line range. */
export const cloneLocationSchema = z.strictObject({
	path: relativePathSchema,
	range: rangeSchema,
});
export type CloneLocation = z.infer<typeof cloneLocationSchema>;

/** Deterministic location order: path, then start line/column, then end line. */
export function compareCloneLocations(a: CloneLocation, b: CloneLocation): number {
	if (a.path !== b.path) {
		return a.path < b.path ? -1 : 1;
	}
	if (a.range.start.line !== b.range.start.line) {
		return a.range.start.line - b.range.start.line;
	}
	const aColumn = a.range.start.column ?? 0;
	const bColumn = b.range.start.column ?? 0;
	if (aColumn !== bColumn) {
		return aColumn - bColumn;
	}
	return a.range.end.line - b.range.end.line;
}

/**
 * A clone **pair**: exactly two distinct, deterministically ordered member
 * locations (the weaker first, §3.2 determinism).
 */
export const clonePairSchema = z
	.strictObject({
		kind: z.literal("pair"),
		matchMode: cloneMatchModeSchema,
		members: z.tuple([cloneLocationSchema, cloneLocationSchema]),
	})
	.superRefine((pair, ctx) => {
		const [first, second] = pair.members;
		if (compareCloneLocations(first, second) === 0) {
			ctx.addIssue({
				code: "custom",
				message: "a clone pair's members must be two distinct locations",
				path: ["members"],
			});
			return;
		}
		if (compareCloneLocations(first, second) > 0) {
			ctx.addIssue({
				code: "custom",
				message: "clone pair members must be in deterministic location order",
				path: ["members"],
			});
		}
	});
export type ClonePair = z.infer<typeof clonePairSchema>;

/**
 * Group match modes: `near` is excluded — near-match similarity is
 * nontransitive and cannot safely form equivalence groups.
 */
export const groupMatchModeSchema = cloneMatchModeSchema.exclude(["near"]);

/**
 * A clone **group**: one content-identical run shared by at least two
 * members, in strictly ascending deterministic location order (unique,
 * sorted). Never equated with pairs (AC3).
 */
export const cloneGroupEvidenceSchema = z
	.strictObject({
		kind: z.literal("group"),
		matchMode: groupMatchModeSchema,
		members: z.array(cloneLocationSchema).min(2),
	})
	.superRefine((group, ctx) => {
		for (let i = 1; i < group.members.length; i++) {
			const previous = group.members[i - 1];
			const current = group.members[i];
			if (previous === undefined || current === undefined) {
				continue;
			}
			if (compareCloneLocations(previous, current) >= 0) {
				ctx.addIssue({
					code: "custom",
					message: "clone group members must be distinct and in deterministic location order",
					path: ["members", i],
				});
				return;
			}
		}
	});
export type CloneGroupEvidence = z.infer<typeof cloneGroupEvidenceSchema>;

/** Clone evidence: a pair or a group — distinct units, never equated (AC3). */
export const cloneEvidenceSchema = z.discriminatedUnion("kind", [
	clonePairSchema,
	cloneGroupEvidenceSchema,
]);
export type CloneEvidence = z.infer<typeof cloneEvidenceSchema>;
