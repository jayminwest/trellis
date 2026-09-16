/**
 * Audit report contract (SPEC §6.4) — the versioned per-run document the
 * deterministic core assembles. Raw metrics live in `metrics`, strictly
 * separate from the score contributions that trace back to them (SPEC §3.2);
 * safeguard evidence rides alongside and is never folded into the score
 * (SPEC §5.5).
 *
 * Cross-field invariants (enforced by {@link auditReportSchema}):
 *   1. every `metrics` map key equals its metric's `id` — the map is keyed
 *      for lookup, never relabeled;
 *   2. `completeness: "complete"` forbids any `incomplete` metric, requires
 *      the score to be present, and forbids `score.partial` — an apparently
 *      complete headline over a partial measurement is a misleading state
 *      (SPEC §3.4, §6);
 *   3. a withheld score (`score` absent) or a `partial` score forbids
 *      `completeness: "complete"` — a missing required dimension blocks or
 *      explicitly flags the headline, never silently completes (SPEC §3.4);
 *   4. every contribution's `metricIds` resolve into the `metrics` map —
 *      every point is traceable to raw metrics (SPEC §7).
 *
 * Run metadata (`run`) is the only non-deterministic field group: timestamps
 * and durations are recorded for operators but excluded from the measurement
 * payload's equality and fingerprint inputs (SPEC §3.5 — see payload.ts).
 */
import { z } from "zod";
import { findingSchema } from "./finding.ts";
import { metricValueSchema } from "./metric.ts";
import { safeguardResultSchema } from "./safeguard.ts";
import { sourceCoverageSchema } from "./source-coverage.ts";
import { analysisStateSchema } from "./states.ts";
import { versionStringSchema } from "./versions.ts";

/** The audited repository's identity. */
export const repoIdentitySchema = z.strictObject({
	/** Absolute path of the audited root. */
	root: z.string().min(1),
	/** Stable repository identity (SPEC §10) — survives basename collisions. */
	identity: z.string().min(1),
});

export type RepoIdentity = z.infer<typeof repoIdentitySchema>;

/** One dimension's traceable contribution to the index (SPEC §7). */
export const scoreContributionSchema = z.strictObject({
	/** The scoring dimension (e.g. `complexity-erosion`, `duplication`). */
	dimension: z.string().min(1),
	/** Points this dimension added to the index (0–100, lower is better). */
	points: z.number().finite().min(0).max(100),
	/** Raw metric ids (keys of the report's `metrics` map) behind the points. */
	metricIds: z.array(z.string().min(1)),
	/** Free-form context (thresholds applied, grouping notes, …). */
	note: z.string().optional(),
});

export type ScoreContribution = z.infer<typeof scoreContributionSchema>;

/** The headline sloppiness index and its traceable contributions (SPEC §6.4). */
export const scoreSchema = z.strictObject({
	/** 0–100 sloppiness index — LOWER IS BETTER, not a percentage (SPEC §3.4). */
	index: z.number().finite().min(0).max(100),
	/** Display direction — renderers must always show it (SPEC §3.4). */
	direction: z.literal("lower-is-better"),
	/** True when a required dimension is incomplete (SPEC §3.4). */
	partial: z.boolean(),
	/** Per-dimension points, traceable to raw metrics (SPEC §7). */
	contributions: z.array(scoreContributionSchema),
});

export type Score = z.infer<typeof scoreSchema>;

/**
 * Non-deterministic run metadata. Recorded for operators; **excluded** from
 * the measurement payload's equality and fingerprint inputs (SPEC §3.5).
 */
export const runMetadataSchema = z.strictObject({
	/** ISO-8601 wall-clock time the audit ran. */
	auditedAt: z.string().datetime({ offset: true }),
	/** Wall-clock duration of the run, in milliseconds. */
	durationMs: z.number().nonnegative().optional(),
});

export type RunMetadata = z.infer<typeof runMetadataSchema>;

/** The versioned per-run audit report (SPEC §6.4). */
export const auditReportSchema = z
	.strictObject({
		/** Contract version (SPEC §3.5). */
		schemaVersion: versionStringSchema,
		/** trellis release that produced the measurements (SPEC §3.5). */
		analyzerVersion: versionStringSchema,
		/** Sloppiness formula version (SPEC §3.5, §7). */
		scoringVersion: versionStringSchema,
		/** The audited repository. */
		repo: repoIdentitySchema,
		/** Source coverage per set — distinct from completeness (SPEC §3.3). */
		sourceCoverage: sourceCoverageSchema,
		/** Analysis-state rollup over the metrics (SPEC §3.3). */
		completeness: analysisStateSchema,
		/** Raw metrics by id — separate from score contributions (SPEC §3.2). */
		metrics: z.record(z.string().min(1), metricValueSchema),
		/** The headline index; absent when a required dimension blocks it. */
		score: scoreSchema.optional(),
		/** Located evidence, deterministically ordered (SPEC §3.2). */
		findings: z.array(findingSchema),
		/** Safeguard evidence — separate, never scored (SPEC §5.5). */
		safeguards: z.array(safeguardResultSchema),
		/** Non-deterministic run metadata (excluded from the payload, SPEC §3.5). */
		run: runMetadataSchema.optional(),
	})
	.superRefine((report, ctx) => {
		for (const [key, metric] of Object.entries(report.metrics)) {
			if (key !== metric.id) {
				ctx.addIssue({
					code: "custom",
					message: `metrics map key "${key}" must equal the metric id "${metric.id}"`,
					path: ["metrics", key],
				});
			}
		}
		const hasIncomplete = Object.values(report.metrics).some(
			(metric) => metric.state === "incomplete",
		);
		if (report.completeness === "complete") {
			if (hasIncomplete) {
				ctx.addIssue({
					code: "custom",
					message: "a complete report must not contain incomplete metrics",
					path: ["completeness"],
				});
			}
			if (report.score === undefined) {
				ctx.addIssue({
					code: "custom",
					message: "a complete report must publish its score",
					path: ["score"],
				});
			}
			if (report.score?.partial === true) {
				ctx.addIssue({
					code: "custom",
					message: "a complete report must not carry a partial score",
					path: ["score", "partial"],
				});
			}
		}
		for (const [index, contribution] of (report.score?.contributions ?? []).entries()) {
			for (const metricId of contribution.metricIds) {
				if (report.metrics[metricId] === undefined) {
					ctx.addIssue({
						code: "custom",
						message: `contribution references unknown metric `"${metricId}"`,
						path: ["score", "contributions", index, "metricIds"],
					});
				}
			}
		}
	});

export type AuditReport = z.infer<typeof auditReportSchema>;
