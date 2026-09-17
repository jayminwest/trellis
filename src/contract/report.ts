/**
 * Audit report contract (SPEC §6.4).
 *
 * The report carries the three §3.5 versions, source coverage, the rolled-up
 * completeness state, raw metrics (separate from score contributions), the
 * 0–100 sloppiness index (lower is better — never a percentage of bad code),
 * deterministically ordered findings, and safeguard evidence (never folded
 * into the score).
 *
 * Cross-field honesty invariants enforced here (SPEC §3.4, §6 intro):
 *
 * - `completeness` must equal the rollup of metric states — a report with an
 *   `incomplete` metric can never claim to look `complete`.
 * - `score.partial` must be true exactly when the report is `incomplete` —
 *   missing analysis blocks or explicitly flags the headline; it is never
 *   silently complete-looking, and never cried wolf on a complete report.
 * - Every score contribution must trace to metrics present on the report
 *   (§7: every point is traceable).
 * - `metrics` map keys must equal the carried metric `id`s.
 *
 * Determinism (SPEC §3.5): the measurement payload excludes run metadata
 * (`run.auditedAt`, `run.durationMs`) from equality and fingerprint inputs —
 * use `measurementPayload` to obtain it.
 */
import { z } from "zod";
import { sourceCoverageSchema } from "./coverage.ts";
import { findingSchema } from "./finding.ts";
import { metricValueSchema } from "./metric.ts";
import { dottedIdSchema, finiteNumberSchema, versionStringSchema } from "./primitives.ts";
import { safeguardResultSchema } from "./safeguard.ts";
import { rollUpCompleteness } from "./states.ts";

/** Per-dimension points, traceable to the raw metrics that produced them (SPEC §7). */
export const scoreContributionSchema = z.strictObject({
	dimension: dottedIdSchema,
	points: finiteNumberSchema.min(0).max(100),
	metricIds: z.array(dottedIdSchema),
});

export type ScoreContribution = z.infer<typeof scoreContributionSchema>;

export const scoreSchema = z.strictObject({
	index: finiteNumberSchema.min(0).max(100),
	direction: z.literal("lower-is-better"),
	partial: z.boolean(),
	contributions: z.array(scoreContributionSchema),
});

export type Score = z.infer<typeof scoreSchema>;

/** Where the audit ran. Commit identity, when present, is metadata only (§8). */
export const repoMetadataSchema = z.strictObject({
	root: z.string().min(1),
	identity: z.string().min(1).optional(),
});

export type RepoMetadata = z.infer<typeof repoMetadataSchema>;

/**
 * Run metadata — timestamps and timings. Recorded for operators but NEVER
 * part of the deterministic measurement payload (§3.5).
 */
export const runMetadataSchema = z.strictObject({
	auditedAt: z.iso.datetime().optional(),
	durationMs: finiteNumberSchema.nonnegative().optional(),
});

export type RunMetadata = z.infer<typeof runMetadataSchema>;

export const auditReportSchema = z
	.strictObject({
		schemaVersion: versionStringSchema,
		analyzerVersion: versionStringSchema,
		scoringVersion: versionStringSchema,
		repo: repoMetadataSchema,
		sourceCoverage: sourceCoverageSchema,
		completeness: z.enum(["complete", "incomplete"]),
		metrics: z.record(dottedIdSchema, metricValueSchema),
		score: scoreSchema,
		findings: z.array(findingSchema),
		safeguards: z.array(safeguardResultSchema),
		run: runMetadataSchema.optional(),
	})
	.superRefine((report, ctx) => {
		const metrics = Object.entries(report.metrics);
		for (const [key, metric] of metrics) {
			if (key !== metric.id) {
				ctx.addIssue({
					code: "custom",
					message: `metrics key "${key}" must equal the metric id "${metric.id}"`,
					path: ["metrics", key, "id"],
				});
			}
		}
		const rolledUp = rollUpCompleteness(metrics.map(([, metric]) => metric.state));
		if (report.completeness !== rolledUp) {
			ctx.addIssue({
				code: "custom",
				message: `completeness "${report.completeness}" does not match the metric-state rollup "${rolledUp}"`,
				path: ["completeness"],
			});
		}
		if (report.score.partial !== (rolledUp === "incomplete")) {
			ctx.addIssue({
				code: "custom",
				message: "score.partial must be true exactly when a metric is incomplete",
				path: ["score", "partial"],
			});
		}
		for (const [i, contribution] of report.score.contributions.entries()) {
			for (const metricId of contribution.metricIds) {
				if (!(metricId in report.metrics)) {
					ctx.addIssue({
						code: "custom",
						message: `contribution "${contribution.dimension}" references unknown metric "${metricId}"`,
						path: ["score", "contributions", i, "metricIds"],
					});
				}
			}
		}
	});

export type AuditReport = z.infer<typeof auditReportSchema>;

/**
 * The deterministic measurement payload (SPEC §3.5, §6.4): the report minus
 * run metadata. Same files + same configuration + same analyzer/scoring
 * versions ⇒ equal payload. Use this (never the raw report) as the input to
 * equality checks and fingerprinting.
 */
export type MeasurementPayload = Omit<AuditReport, "run">;

export function measurementPayload(report: AuditReport): MeasurementPayload {
	const payload = { ...report };
	delete payload.run;
	return payload;
}
