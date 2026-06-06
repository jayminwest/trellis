/**
 * Rubric record schemas (SPEC §6.1) — the WHAT layer, which never names a tool.
 *
 * zod schemas for the two authored record kinds: category records
 * (`categories.yaml`) and criterion records (`repo-scope.yaml` /
 * `app-scope.yaml`). Per-record shape and cross-field invariants live here;
 * cross-record invariants (unique ids, one gate per category, category
 * references resolve, scope matches source file) live in the loader.
 */
import { z } from "zod";

/** Criterion scope: a single repo-level fact, or one fact per discovered app. */
export const SCOPES = ["repo", "app"] as const;
export type Scope = (typeof SCOPES)[number];

/** How a criterion is decided: a deterministic check, or an agent investigation. */
export const DISCOVERY_VIA = ["deterministic", "agent"] as const;
export type DiscoveryVia = (typeof DISCOVERY_VIA)[number];

/** The four fixed investigation areas (SPEC §7). */
export const INVESTIGATION_AREAS = [
	"documentation",
	"agent-config",
	"setup-runnability",
	"test-layout",
] as const;
export type InvestigationArea = (typeof INVESTIGATION_AREAS)[number];

/** Lower-snake_case identifier: leading letter, `_`-joined alphanumeric groups. */
const snakeCaseId = z.string().regex(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/, "must be snake_case");

/**
 * Category record (`categories.yaml`): id + human framing only. No scoring
 * weight — categories group criteria, they are not scored directly.
 */
export const categoryRecordSchema = z.strictObject({
	id: snakeCaseId,
	title: z.string().min(1),
	description: z.string().min(1),
});

export type CategoryRecord = z.infer<typeof categoryRecordSchema>;

/**
 * Criterion record (`repo-scope.yaml` / `app-scope.yaml`).
 *
 * `gate` and `weight` are **reserved** — carried in the data and validated, but
 * not read by the v0 scorer (SPEC §3.3). Cross-field invariant enforced here:
 * `investigation` is non-null IFF `discoveryVia` is `agent`.
 */
export const criterionRecordSchema = z
	.strictObject({
		id: snakeCaseId,
		category: snakeCaseId,
		scope: z.enum(SCOPES),
		level: z.number().int().min(1).max(5),
		skippable: z.boolean(),
		discoveryVia: z.enum(DISCOVERY_VIA),
		investigation: z.enum(INVESTIGATION_AREAS).nullable().default(null),
		gate: z.boolean().default(false),
		weight: z.number().positive().default(1),
	})
	.superRefine((rec, ctx) => {
		const needsArea = rec.discoveryVia === "agent";
		if (needsArea && rec.investigation === null) {
			ctx.addIssue({
				code: "custom",
				message: "investigation must be non-null when discoveryVia is 'agent'",
				path: ["investigation"],
			});
		}
		if (!needsArea && rec.investigation !== null) {
			ctx.addIssue({
				code: "custom",
				message: "investigation must be null when discoveryVia is 'deterministic'",
				path: ["investigation"],
			});
		}
	});

export type CriterionRecord = z.infer<typeof criterionRecordSchema>;
