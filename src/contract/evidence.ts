/**
 * The report's evidence area (SPEC §6.6, §16.2 — plan `pl-43c5` step 5,
 * trellis-a24d).
 *
 * The §6.4 report gains an **additive per-analysis evidence area**: one entry
 * per carried analysis, native or external, each carrying the step-2 analysis
 * result — provider identity, one of the five §16.2 states, analysis
 * identity, observed coverage — plus the two report-level declarations that
 * make completeness honest:
 *
 * - `scoring` — the analysis's role in the report's score (§16.5): **scored**
 *   analyses feed the index; **advisory** analyses never do. Score
 *   completeness is computed only from the declared scored inputs, so an
 *   absent, unavailable or incomplete advisory analysis can never flip a
 *   complete native score to partial — and a scored prerequisite's failure
 *   still does.
 * - `metricIds` — the native metric ids the analysis owns. Native evidence
 *   (values, findings) lives in the report's own areas and is never
 *   duplicated per entry; external evidence is namespaced inside its entry
 *   and never owns native metrics (§16.5).
 *
 * The area also carries the **overall evidence completeness** — rolled up
 * from every carried analysis state plus the native metric states — which is
 * an independent quantity from score completeness (§16.2): neither implies
 * the other.
 */
import { z } from "zod";
import { analysisResultSchema } from "./analysis-result.ts";
import type { MetricValue } from "./metric.ts";
import { dottedIdSchema } from "./primitives.ts";
import type { ProviderState } from "./provider.ts";
import { type Completeness, rollUpCompleteness } from "./states.ts";

/** The role one carried analysis plays in the report's score (§16.5). */
export const SCORING_ROLES = ["scored", "advisory"] as const;
export type ScoringRole = (typeof SCORING_ROLES)[number];
export const scoringRoleSchema = z.enum(SCORING_ROLES);

/**
 * Analysis states that leave a gap (§16.2): the analysis ran partially
 * (`incomplete`) or could not run at all (`unavailable` / `unsupported`).
 * `complete` and `unrequested` never degrade anything — an unrequested
 * analysis is an explicit absence, not a failed promise.
 */
const GAP_STATES: ReadonlySet<ProviderState> = new Set([
	"incomplete",
	"unavailable",
	"unsupported",
]);

/** Strictly increasing (unique, sorted) string values. */
function isSortedUnique(values: readonly string[]): boolean {
	for (let i = 1; i < values.length; i++) {
		const previous = values[i - 1];
		const current = values[i];
		if (previous === undefined || current === undefined || previous >= current) {
			return false;
		}
	}
	return true;
}

/**
 * One carried analysis's report entry (§6.6): the step-2 analysis result plus
 * the scoring role and native metric ownership declarations. Structural
 * rules beyond the §16.2 state matrix:
 *
 * - native entries own at least one metric id and carry **no measured
 *   output** — native metrics and findings live in the report's own areas, so
 *   the entry is the ownership declaration, never a diverging copy;
 * - external entries own no native metric ids — their namespaced evidence
 *   lives inside the entry.
 */
export const reportAnalysisSchema = analysisResultSchema
	.extend({
		scoring: scoringRoleSchema,
		metricIds: z.array(dottedIdSchema),
	})
	.superRefine((entry, ctx) => {
		const addIssue = (message: string, path: (string | number)[]): void => {
			ctx.addIssue({ code: "custom", message, path });
		};
		if (!isSortedUnique(entry.metricIds)) {
			addIssue("owned metric ids must be unique and sorted", ["metricIds"]);
		}
		if (entry.provider.kind === "native") {
			if (entry.metricIds.length === 0) {
				addIssue("a native analysis owns at least one metric id", ["metricIds"]);
			}
			for (const field of ["metrics", "findings", "cloneEvidence"] as const) {
				if (entry[field] !== undefined) {
					addIssue(
						`native evidence lives in the report's metrics map and findings, never duplicated per entry: "${field}" must be absent`,
						[field],
					);
				}
			}
			return;
		}
		if (entry.metricIds.length > 0) {
			addIssue(
				"external evidence is namespaced inside its entry and never owns native metric ids",
				["metricIds"],
			);
		}
	});

export type ReportAnalysis = z.infer<typeof reportAnalysisSchema>;

/**
 * The evidence area (§6.6): the carried analyses — unique, in provider-id
 * order, so the same analyses always serialize identically — plus the
 * overall evidence completeness rolled up from them (and the native metric
 * states; see {@link rollUpEvidenceCompleteness}).
 */
export const evidenceAreaSchema = z
	.strictObject({
		completeness: z.enum(["complete", "incomplete"]),
		analyses: z.array(reportAnalysisSchema),
	})
	.superRefine((area, ctx) => {
		if (!isSortedUnique(area.analyses.map((analysis) => analysis.provider.id))) {
			ctx.addIssue({
				code: "custom",
				message: "analyses must be unique and ordered by provider id",
				path: ["analyses"],
			});
		}
	});

export type EvidenceArea = z.infer<typeof evidenceAreaSchema>;

/**
 * Overall evidence completeness (§16.2, §3.3): `incomplete` when any carried
 * analysis shows a gap (ran partially or could not run) or any native metric
 * is `incomplete`. `unrequested` analyses never degrade it, and it is an
 * independent quantity from score completeness — an incomplete advisory
 * analysis makes the evidence incomplete without touching the score.
 */
export function rollUpEvidenceCompleteness(
	analyses: readonly ReportAnalysis[],
	metrics: readonly MetricValue[],
): Completeness {
	if (analyses.some((analysis) => GAP_STATES.has(analysis.state))) {
		return "incomplete";
	}
	return rollUpCompleteness(metrics.map((metric) => metric.state));
}

/**
 * Score completeness (§16.5): computed **only from the declared scored
 * inputs** — a scored analysis that shows a gap, or an `incomplete` metric a
 * scored analysis owns. Advisory analyses and the metrics they own never
 * enter it, so an absent or incomplete optional analysis can never flip a
 * complete native score to partial; a scored prerequisite's failure still
 * does.
 */
export function rollUpScoreCompleteness(
	analyses: readonly ReportAnalysis[],
	metrics: Readonly<Record<string, MetricValue>>,
): Completeness {
	for (const analysis of analyses) {
		if (analysis.scoring !== "scored") continue;
		if (GAP_STATES.has(analysis.state)) return "incomplete";
		for (const id of analysis.metricIds) {
			if (metrics[id]?.state === "incomplete") return "incomplete";
		}
	}
	return "complete";
}
