/**
 * The minimum analysis result contract (SPEC §16.2, trellis-90d6, AC4).
 *
 * One interface represents native analyzers and external providers alike:
 * provenance (provider identity + analysis identity), one of the five
 * provider states, observed coverage, and — only for measured states —
 * metrics, findings and clone evidence. The state matrix is enforced
 * structurally so contradictory statuses cannot validate (AC5):
 *
 * | state       | analysis | coverage   | reason  | evidence |
 * |-------------|----------|------------|---------|----------|
 * | unrequested | absent   | absent     | absent  | absent   |
 * | unavailable | optional | absent     | present | absent   |
 * | unsupported | optional | absent     | present | absent   |
 * | incomplete  | present  | present    | present| allowed |
 * | complete    | present  | = selection| absent  | allowed |
 *
 * A `complete` result must have observed exactly its selected files with no
 * diagnostics and no unsupported context — a successful process with empty
 * output can never establish complete coverage (§16.2; the spike's empty
 * graph). Measured output always carries provenance, and external evidence
 * carries namespaced identities (`provider.<id>.…`) so it never collides
 * with native metrics or finding kinds (§16.5).
 */
import { z } from "zod";
import {
	analysisIdentitySchema,
	executionMetadataSchema,
	observedCoverageSchema,
} from "./analysis.ts";
import { cloneEvidenceSchema } from "./clone-evidence.ts";
import { findingSchema } from "./finding.ts";
import { metricValueSchema } from "./metric.ts";
import { dottedIdSchema, relativePathSchema } from "./primitives.ts";
import { EVIDENCE_NAMESPACE, providerIdentitySchema, providerStateSchema } from "./provider.ts";

export const analysisResultSchema = z
	.strictObject({
		provider: providerIdentitySchema,
		state: providerStateSchema,
		analysis: analysisIdentitySchema.optional(),
		reason: z.string().min(1).optional(),
		location: relativePathSchema.optional(),
		observedCoverage: observedCoverageSchema.optional(),
		execution: executionMetadataSchema.optional(),
		metrics: z.array(metricValueSchema).optional(),
		findings: z.array(findingSchema).optional(),
		cloneEvidence: z.array(cloneEvidenceSchema).optional(),
	})
	.superRefine((result, ctx) => {
		validateProvenance(result, ctx);
		validateNamespacing(result, ctx);
		validateState(result, ctx);
	});

export type AnalysisResult = z.infer<typeof analysisResultSchema>;

/** Fields that constitute measured output (never fabricated for absent states). */
const MEASURED_OUTPUT_FIELDS = ["metrics", "findings", "cloneEvidence"] as const;

function hasMeasuredOutput(result: AnalysisResult): boolean {
	return MEASURED_OUTPUT_FIELDS.some((field) => result[field] !== undefined);
}

function addIssue(ctx: z.RefinementCtx, message: string, path: (string | number)[]): void {
	ctx.addIssue({ code: "custom", message, path });
}

/** Measured output always carries the analysis identity that produced it (AC3, AC5). */
function validateProvenance(result: AnalysisResult, ctx: z.RefinementCtx): void {
	if (hasMeasuredOutput(result) && result.analysis === undefined) {
		addIssue(
			ctx,
			"measured output (metrics, findings, clone evidence) requires the analysis identity that produced it",
			["analysis"],
		);
	}
}

/** Whether an external evidence id is `provider.<providerId>.<valid dotted name>`. */
function isExternalEvidenceId(id: string, prefix: string): boolean {
	return id.startsWith(prefix) && dottedIdSchema.safeParse(id.slice(prefix.length)).success;
}

function validateExternalNamespacing(result: AnalysisResult, ctx: z.RefinementCtx): void {
	const prefix = `${EVIDENCE_NAMESPACE}.${result.provider.id}.`;
	for (const [index, metric] of (result.metrics ?? []).entries()) {
		if (!isExternalEvidenceId(metric.id, prefix)) {
			addIssue(
				ctx,
				`external metric ids must be namespaced "${prefix}<name>" — got "${metric.id}"`,
				["metrics", index, "id"],
			);
		}
	}
	for (const [index, finding] of (result.findings ?? []).entries()) {
		if (!isExternalEvidenceId(finding.kind, prefix)) {
			addIssue(
				ctx,
				`external finding kinds must be namespaced "${prefix}<kind>" — got "${finding.kind}"`,
				["findings", index, "kind"],
			);
		}
	}
}

/** The `provider.` namespace is reserved: native results never carry external evidence ids. */
function validateNativeNamespaceReserved(result: AnalysisResult, ctx: z.RefinementCtx): void {
	const reserved = `${EVIDENCE_NAMESPACE}.`;
	for (const [index, metric] of (result.metrics ?? []).entries()) {
		if (metric.id.startsWith(reserved)) {
			addIssue(
				ctx,
				`native metric ids must not use the reserved "${reserved}" namespace — got "${metric.id}"`,
				["metrics", index, "id"],
			);
		}
	}
	for (const [index, finding] of (result.findings ?? []).entries()) {
		if (finding.kind.startsWith(reserved)) {
			addIssue(
				ctx,
				`native finding kinds must not use the reserved "${reserved}" namespace — got "${finding.kind}"`,
				["findings", index, "kind"],
			);
		}
	}
}

function validateNamespacing(result: AnalysisResult, ctx: z.RefinementCtx): void {
	if (result.provider.kind === "external") {
		validateExternalNamespacing(result, ctx);
		return;
	}
	validateNativeNamespaceReserved(result, ctx);
}

function rejectExtras(
	result: AnalysisResult,
	ctx: z.RefinementCtx,
	fields: readonly string[],
	message: string,
): void {
	for (const field of fields) {
		if (result[field as keyof AnalysisResult] !== undefined) {
			addIssue(ctx, `${message}: "${field}" must be absent`, [field]);
		}
	}
}

const UNREQUESTED_FIELDS = [
	"analysis",
	"reason",
	"location",
	"observedCoverage",
	"execution",
	"metrics",
	"findings",
	"cloneEvidence",
] as const;

const NEVER_RAN_FIELDS = ["observedCoverage", "metrics", "findings", "cloneEvidence"] as const;

/** An analysis that never ran (unavailable/unsupported) is located, with a reason — never fabricated evidence (§16.2). */
function validateNeverRan(result: AnalysisResult, ctx: z.RefinementCtx): void {
	rejectExtras(
		result,
		ctx,
		NEVER_RAN_FIELDS,
		`a ${result.state} analysis never ran and cannot fabricate evidence`,
	);
	if (result.reason === undefined) {
		addIssue(ctx, `a ${result.state} analysis must carry a reason`, ["reason"]);
	}
}

/** Coverage can never exceed the selection: an analyzed file outside the intent is contradictory (AC2). */
function requireCoverageWithinSelection(result: AnalysisResult, ctx: z.RefinementCtx): void {
	const intended = new Set(result.analysis?.selection.files.map((file) => file.path) ?? []);
	for (const [index, path] of (result.observedCoverage?.analyzedFiles ?? []).entries()) {
		if (!intended.has(path)) {
			addIssue(ctx, `analyzed file "${path}" is outside the analysis selection`, [
				"observedCoverage",
				"analyzedFiles",
				index,
			]);
		}
	}
}

/** An incomplete analysis must show a gap: missing files, diagnostics, or unsupported context (§16.2). */
function requireCoverageGap(result: AnalysisResult, ctx: z.RefinementCtx): void {
	const coverage = result.observedCoverage;
	const analysis = result.analysis;
	if (coverage === undefined || analysis === undefined) {
		return;
	}
	const fullyCovered =
		coverage.analyzedFiles.length === analysis.selection.files.length &&
		coverage.diagnostics.length === 0 &&
		coverage.unsupported.length === 0;
	if (fullyCovered) {
		addIssue(
			ctx,
			"an incomplete analysis must show a coverage gap (missing files, diagnostics, or unsupported context)",
			["state"],
		);
	}
}

function validateIncomplete(result: AnalysisResult, ctx: z.RefinementCtx): void {
	if (result.analysis === undefined) {
		addIssue(ctx, "an incomplete analysis must carry its analysis identity", ["analysis"]);
	}
	if (result.observedCoverage === undefined) {
		addIssue(ctx, "an incomplete analysis must carry what it did observe", ["observedCoverage"]);
	}
	if (result.reason === undefined) {
		addIssue(ctx, "an incomplete analysis must carry a reason (what could not be analyzed)", [
			"reason",
		]);
	}
	requireCoverageWithinSelection(result, ctx);
	requireCoverageGap(result, ctx);
}

/**
 * A complete analysis observed exactly its selection — no diagnostics, no
 * unsupported context, and never fewer files than intended. Empty or partial
 * output cannot establish complete coverage (§16.2, AC2).
 */
function requireCompleteCoverage(result: AnalysisResult, ctx: z.RefinementCtx): void {
	const coverage = result.observedCoverage;
	if (coverage === undefined) {
		return;
	}
	if (coverage.diagnostics.length > 0) {
		addIssue(ctx, "a complete analysis carries no diagnostics", [
			"observedCoverage",
			"diagnostics",
		]);
	}
	if (coverage.unsupported.length > 0) {
		addIssue(ctx, "a complete analysis carries no unsupported context", [
			"observedCoverage",
			"unsupported",
		]);
	}
	const intended = (result.analysis?.selection.files ?? []).map((file) => file.path).join("\n");
	if (coverage.analyzedFiles.join("\n") !== intended) {
		addIssue(
			ctx,
			"a complete analysis must have observed exactly its selected files — empty or partial output cannot establish complete coverage",
			["observedCoverage", "analyzedFiles"],
		);
	}
}

function validateComplete(result: AnalysisResult, ctx: z.RefinementCtx): void {
	if (result.analysis === undefined) {
		addIssue(ctx, "a complete analysis must carry its analysis identity", ["analysis"]);
	}
	if (result.observedCoverage === undefined) {
		addIssue(ctx, "a complete analysis must carry asserted observed coverage", [
			"observedCoverage",
		]);
	}
	if (result.reason !== undefined) {
		addIssue(ctx, "a complete analysis has no failure to explain", ["reason"]);
	}
	if (result.location !== undefined) {
		addIssue(ctx, "location is only meaningful for a failed or partial analysis", ["location"]);
	}
	requireCompleteCoverage(result, ctx);
}

function validateState(result: AnalysisResult, ctx: z.RefinementCtx): void {
	switch (result.state) {
		case "unrequested":
			rejectExtras(result, ctx, UNREQUESTED_FIELDS, "an unrequested analysis carries no evidence");
			return;
		case "unavailable":
		case "unsupported":
			validateNeverRan(result, ctx);
			return;
		case "incomplete":
			validateIncomplete(result, ctx);
			return;
		case "complete":
			validateComplete(result, ctx);
	}
}
