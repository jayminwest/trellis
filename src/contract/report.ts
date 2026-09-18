/**
 * Audit report contract (SPEC §6.4, §16.6 — trellis-a24d).
 *
 * The report carries the three §3.5 versions, source coverage, the rolled-up
 * completeness state, raw metrics (separate from score contributions), the
 * 0–100 sloppiness index (lower is better — never a percentage of bad code),
 * deterministically ordered findings, and safeguard evidence (never folded
 * into the score). Since schema `1.1.0` it also carries the **per-analysis
 * evidence area** (§6.6): every measured analysis's provenance/status plus
 * the declarations that keep completeness honest.
 *
 * Cross-field honesty invariants enforced here (SPEC §3.4, §6 intro, §16.2):
 *
 * - `completeness` must equal the rollup of metric states — a report with an
 *   `incomplete` metric can never claim to look `complete`. Provider states
 *   never roll into this native rollup (§16.2).
 * - Every score contribution must trace to metrics present on the report
 *   (§7: every point is traceable) — and, on evidence-carrying reports, to
 *   a **scored** analysis: advisory evidence never enters the score (§16.5).
 * - `metrics` map keys must equal the carried metric `id`s.
 *
 * Version-aware reading (§16.6): the contract is a discriminated union on
 * `schemaVersion`. Each supported version keeps its own interpretation:
 *
 * - **1.0.0 (pre-provider)** — the original report: no evidence area (a
 *   report claiming one is rejected, never relabeled), and `score.partial`
 *   is true exactly when the metric-state rollup is `incomplete`.
 * - **1.1.0 (evidence-carrying)** — overall evidence completeness
 *   (`evidence.completeness`, rolled up from the carried analyses and the
 *   metric states) is **independent** from score completeness
 *   (`score.partial`, computed only from the declared scored inputs): an
 *   incomplete advisory analysis makes the evidence incomplete without
 *   flipping a complete native score, and a scored prerequisite's failure
 *   still marks the score partial.
 *
 * Unknown or newer-incompatible schema versions fail at the discriminator
 * with the supported versions named, instead of loading with guessed
 * semantics.
 *
 * Determinism (SPEC §3.5): the measurement payload excludes run metadata
 * (`run.auditedAt`, `run.durationMs`) from equality and fingerprint inputs —
 * use `measurementPayload` to obtain it.
 */
import { z } from "zod";
import { sourceCoverageSchema } from "./coverage.ts";
import {
	type EvidenceArea,
	evidenceAreaSchema,
	type ReportAnalysis,
	rollUpEvidenceCompleteness,
	rollUpScoreCompleteness,
	type ScoringRole,
} from "./evidence.ts";
import { historicalFindingSchema } from "./finding.ts";
import { type MetricValue, metricValueSchema } from "./metric.ts";
import { dottedIdSchema, finiteNumberSchema, versionStringSchema } from "./primitives.ts";
import { safeguardResultSchema } from "./safeguard.ts";
import { rollUpCompleteness } from "./states.ts";
import { PRE_PROVIDER_SCHEMA_VERSION, SCHEMA_VERSION } from "./version.ts";

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

/** The measurement body every report version shares (everything but `schemaVersion`). */
const reportBody = {
	analyzerVersion: versionStringSchema,
	scoringVersion: versionStringSchema,
	repo: repoMetadataSchema,
	sourceCoverage: sourceCoverageSchema,
	completeness: z.enum(["complete", "incomplete"]),
	metrics: z.record(dottedIdSchema, metricValueSchema),
	score: scoreSchema,
	findings: z.array(historicalFindingSchema),
	safeguards: z.array(safeguardResultSchema),
	run: runMetadataSchema.optional(),
} as const;

/** One metric owner: which analysis entry owns a metric id, and its scoring role. */
interface MetricOwner {
	providerId: string;
	scoring: ScoringRole;
}

/** The report fields the shared honesty checks read. */
interface HonestReportFields {
	metrics: Record<string, MetricValue>;
	completeness: "complete" | "incomplete";
	score: Score;
}

/**
 * Shared §6.4 honesty checks (both versions): metric keys match their ids,
 * `completeness` equals the metric-state rollup (§3.3 — provider states
 * never roll in), and every contribution traces to a metric present on the
 * report (§7).
 */
function validateMeasurementHonesty(report: HonestReportFields, ctx: z.RefinementCtx): void {
	for (const [key, metric] of Object.entries(report.metrics)) {
		if (key !== metric.id) {
			ctx.addIssue({
				code: "custom",
				message: `metrics key "${key}" must equal the metric id "${metric.id}"`,
				path: ["metrics", key, "id"],
			});
		}
	}
	const rolledUp = rollUpCompleteness(Object.values(report.metrics).map((metric) => metric.state));
	if (report.completeness !== rolledUp) {
		ctx.addIssue({
			code: "custom",
			message: `completeness "${report.completeness}" does not match the metric-state rollup "${rolledUp}"`,
			path: ["completeness"],
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
}

/**
 * The pre-provider report (schema `1.0.0`, §16.6): the original §6.4 shape.
 * Stored artifacts keep their original interpretation — no evidence area (a
 * report claiming one is rejected), and the headline folds completeness:
 * `score.partial` is true exactly when a metric is incomplete.
 */
export const preProviderAuditReportSchema = z
	.strictObject({
		schemaVersion: z.literal(PRE_PROVIDER_SCHEMA_VERSION),
		...reportBody,
	})
	.superRefine((report, ctx) => {
		validateMeasurementHonesty(report, ctx);
		if (report.score.partial !== (report.completeness === "incomplete")) {
			ctx.addIssue({
				code: "custom",
				message: "score.partial must be true exactly when a metric is incomplete",
				path: ["score", "partial"],
			});
		}
	});

/** A pre-provider (schema 1.0.0) report. */
export type PreProviderAuditReport = z.infer<typeof preProviderAuditReportSchema>;

/**
 * Metric ownership (AC3): every native analysis entry declares the metric
 * ids it owns; each owned id must be present in the report's metrics map,
 * each map key must have exactly one owning entry, and no id may be owned
 * twice. Returns the ownership map (metric id → owning entry) for the
 * contributor checks.
 */
function validateMetricOwnership(
	analyses: readonly ReportAnalysis[],
	metrics: Readonly<Record<string, MetricValue>>,
	ctx: z.RefinementCtx,
): Map<string, MetricOwner> {
	const owners = new Map<string, MetricOwner>();
	for (const [i, analysis] of analyses.entries()) {
		for (const metricId of analysis.metricIds) {
			const previous = owners.get(metricId);
			if (previous !== undefined) {
				ctx.addIssue({
					code: "custom",
					message: `metric "${metricId}" is owned by both "${previous.providerId}" and "${analysis.provider.id}"`,
					path: ["evidence", "analyses", i, "metricIds"],
				});
				continue;
			}
			owners.set(metricId, { providerId: analysis.provider.id, scoring: analysis.scoring });
			if (!(metricId in metrics)) {
				ctx.addIssue({
					code: "custom",
					message: `analysis "${analysis.provider.id}" owns metric "${metricId}" which is absent from the report`,
					path: ["evidence", "analyses", i, "metricIds"],
				});
			}
		}
	}
	for (const key of Object.keys(metrics)) {
		if (!owners.has(key)) {
			ctx.addIssue({
				code: "custom",
				message: `metric "${key}" has no owning analysis`,
				path: ["metrics", key],
			});
		}
	}
	return owners;
}

/** Score contributors (AC3, §16.5): every contribution traces to a metric owned by a scored analysis. */
function validateScoreContributors(
	contributions: readonly ScoreContribution[],
	owners: ReadonlyMap<string, MetricOwner>,
	ctx: z.RefinementCtx,
): void {
	for (const [i, contribution] of contributions.entries()) {
		for (const metricId of contribution.metricIds) {
			if (owners.get(metricId)?.scoring !== "scored") {
				ctx.addIssue({
					code: "custom",
					message: `contribution "${contribution.dimension}" must trace to metric "${metricId}" owned by a scored analysis`,
					path: ["score", "contributions", i, "metricIds"],
				});
			}
		}
	}
}

/**
 * The completeness split (§16.2): overall evidence completeness must equal
 * the analyses/metric-state rollup, and score completeness — computed only
 * from the declared scored inputs — must equal `score.partial`. The two are
 * independent: an incomplete advisory analysis degrades the evidence without
 * flipping a complete native score.
 */
function validateCompletenessIndependence(
	report: {
		metrics: Record<string, MetricValue>;
		score: Score;
		evidence: EvidenceArea;
	},
	ctx: z.RefinementCtx,
): void {
	const scoreCompleteness = rollUpScoreCompleteness(report.evidence.analyses, report.metrics);
	if (report.score.partial !== (scoreCompleteness === "incomplete")) {
		ctx.addIssue({
			code: "custom",
			message:
				"score.partial must be true exactly when a declared scored input is incomplete — an advisory analysis never flips a complete score",
			path: ["score", "partial"],
		});
	}
	const evidenceCompleteness = rollUpEvidenceCompleteness(
		report.evidence.analyses,
		Object.values(report.metrics),
	);
	if (report.evidence.completeness !== evidenceCompleteness) {
		ctx.addIssue({
			code: "custom",
			message: `evidence completeness "${report.evidence.completeness}" does not match the analyses/metric-state rollup "${evidenceCompleteness}"`,
			path: ["evidence", "completeness"],
		});
	}
}

/**
 * The evidence-carrying report (schema `1.1.0`, §6.6): the measurement body
 * plus the additive evidence area. Overall evidence completeness and score
 * completeness are independent quantities (§16.2):
 *
 * - `evidence.completeness` must equal the rollup of the carried analysis
 *   states and the native metric states;
 * - `score.partial` must be true exactly when a declared scored input — a
 *   scored analysis showing a gap, or an incomplete metric a scored analysis
 *   owns — leaves the score incomplete;
 * - every metric on the report must be owned by exactly one native analysis
 *   entry, and every owned id must be present (metric ownership);
 * - every contribution must trace to a metric owned by a **scored** analysis
 *   — advisory evidence never enters the score (§16.5).
 */
export const evidenceAuditReportSchema = z
	.strictObject({
		schemaVersion: z.literal(SCHEMA_VERSION),
		...reportBody,
		evidence: evidenceAreaSchema,
	})
	.superRefine((report, ctx) => {
		validateMeasurementHonesty(report, ctx);
		const owners = validateMetricOwnership(report.evidence.analyses, report.metrics, ctx);
		validateScoreContributors(report.score.contributions, owners, ctx);
		validateCompletenessIndependence(report, ctx);
	});

/** An evidence-carrying (schema 1.1.0) report. */
export type EvidenceAuditReport = z.infer<typeof evidenceAuditReportSchema>;

/**
 * The versioned §6.4 audit report: every supported schema version, each read
 * with its own interpretation. Unknown or newer-incompatible versions fail
 * at the `schemaVersion` discriminator with the supported versions named —
 * never loaded with guessed semantics.
 */
export const auditReportSchema = z.discriminatedUnion("schemaVersion", [
	preProviderAuditReportSchema,
	evidenceAuditReportSchema,
]);

export type AuditReport = z.infer<typeof auditReportSchema>;

/**
 * The analyses a report carries (§6.6): the per-analysis provenance/status
 * entries. Pre-provider reports carry none and are never relabeled as
 * provider-aware — their missing evidence reads as absent, never as
 * provider provenance (§16.6).
 */
export function carriedAnalyses(report: AuditReport): readonly ReportAnalysis[] {
	return report.schemaVersion === PRE_PROVIDER_SCHEMA_VERSION ? [] : report.evidence.analyses;
}

/** The measurement payload of one report version, run metadata removed. */
type WithoutRun<T> = T extends unknown ? Omit<T, "run"> : never;

/**
 * The deterministic measurement payload (SPEC §3.5, §6.4): the report minus
 * run metadata. Same files + same configuration + same analyzer/scoring
 * versions ⇒ equal payload. Use this (never the raw report) as the input to
 * equality checks and fingerprinting.
 */
export type MeasurementPayload = WithoutRun<AuditReport>;

export function measurementPayload<T extends AuditReport>(report: T): Omit<T, "run"> {
	const { run: _run, ...payload } = report;
	return payload;
}
