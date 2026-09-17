/**
 * Markdown rendering of the report's optional-provider evidence area (SPEC
 * §6.6, §16.2 — plan `pl-43c5` step 17, trellis-bba6).
 *
 * The section mirrors the terminal view (`./audit-terminal-providers.ts`,
 * step 16) in vocabulary and semantics — it reuses that module's exported
 * helpers (`STATE_LABELS`, `provenance`, `coverageSummary`,
 * `cloneUnitSummary`, and the §16.2/§16.5 notes) so the three renderers can
 * never disagree about a state, a provenance, a coverage claim or a clone
 * unit:
 *
 * - the section appears **only when the report actually carries an external
 *   analysis** — a default native-only audit renders byte-identically, with
 *   no provider noise, and a pre-provider (schema 1.0.0) artifact renders
 *   the same way (no evidence area, never relabeled, §16.6);
 * - every carried analysis is shown with its state (distinguishing *not
 *   requested* from a completed analysis that found nothing), its provenance,
 *   and — when it did not run or ran partially — its located reason: an
 *   unavailable/incomplete/deferred analysis is explained as such, never
 *   rendered as a clean zero;
 * - the structural score stays separate from the advisory dimensions: the
 *   section header says the evidence is never folded into the score, overall
 *   evidence completeness is stated as an independent quantity from score
 *   completeness (§16.2), no provider metric or finding ever appears among
 *   the score contributions, and provider pairs and native clone groups are
 *   distinct units, never summed (§16.5);
 * - findings stay bounded (the total is always printed), each with its
 *   evidence location, in the report's deterministic order — never re-ranked
 *   here — and the section points at the JSON report for the full evidence.
 */
import { type AuditReport, carriedAnalyses, type ReportAnalysis } from "../contract/index.ts";
import { boundFindings, findingLocation, formatMetric } from "./audit-format.ts";
import {
	cloneUnitSummary,
	coverageSummary,
	EVIDENCE_COMPLETE_NOTE,
	EVIDENCE_INCOMPLETE_NOTE,
	MATCH_MODES_NOTE,
	NEVER_SUMMED_NOTE,
	NOT_REQUESTED_NOTE,
	provenance,
	STATE_LABELS,
	ZERO_FINDINGS_NOTE,
} from "./audit-terminal-providers.ts";

/** The section heading: advisory engineering evidence, explicitly unscored (§16.5). */
export const PROVIDER_SECTION_TITLE =
	"Provider analyses (optional engineering evidence — never folded into the score)";

/**
 * Where the fuller evidence lives: the JSON report carries the complete
 * evidence area (selections, clone members, diagnostics and metrics).
 */
const FULL_EVIDENCE_POINTER =
	"Full evidence: the JSON report carries every analysis's selection, clone members, diagnostics and metrics.";

/**
 * Evidence completeness is an independent quantity from score completeness
 * (§16.2): the sloppiness index and its contributions stay native-only.
 */
const INDEPENDENCE_NOTE =
	"Evidence completeness is independent of score completeness; advisory analyses never enter the sloppiness index or its contributions (SPEC §16.5).";

/** Flatten a free-text value so it cannot break the bullet list. */
function inline(text: string): string {
	return text.replaceAll("\n", " ");
}

/** The overall-evidence lines: the verdict, then the independence note (§16.2). */
function evidenceCompletenessLines(report: AuditReport): string[] {
	if (report.schemaVersion !== "1.1.0") {
		throw new Error("external provider evidence requires an evidence-carrying (1.1.0) report");
	}
	const verdict =
		report.evidence.completeness === "complete"
			? `Evidence: ${EVIDENCE_COMPLETE_NOTE}.`
			: `Evidence: ${EVIDENCE_INCOMPLETE_NOTE}.`;
	return [verdict, "", INDEPENDENCE_NOTE];
}

/** The entry's namespaced metrics, rendered with the shared metric formatter (§6.1). */
function metricBullet(analysis: ReportAnalysis): string | undefined {
	const metrics = analysis.metrics;
	if (metrics === undefined || metrics.length === 0) return undefined;
	return `- metrics: ${metrics.map((metric) => `${metric.id} = ${formatMetric(metric)}`).join(" · ")}`;
}

/** The entry's clone-evidence bullets: distinct units, never summed (§16.5). */
function cloneBullets(analysis: ReportAnalysis): string[] {
	const evidence = analysis.cloneEvidence;
	if (evidence === undefined) return [];
	return [
		`- clone evidence: ${cloneUnitSummary(evidence)} — ${NEVER_SUMMED_NOTE}`,
		`- match modes: ${MATCH_MODES_NOTE}`,
	];
}

/**
 * The entry's findings: bounded, in the report's deterministic order (never
 * re-ranked here), each with its evidence location; the total is always
 * printed. A completed analysis with zero findings is an explicit positive
 * result — never the same silence as a provider that never ran.
 */
function findingBullets(analysis: ReportAnalysis, limit: number): string[] {
	const findings = analysis.findings ?? [];
	if (findings.length === 0) {
		return analysis.state === "complete" ? [`- ${ZERO_FINDINGS_NOTE}`] : [];
	}
	const bounded = boundFindings(findings, limit);
	return [
		`- provider findings (${bounded.shown.length} of ${bounded.total}):`,
		...bounded.shown.map(
			(finding) =>
				`  - \`${finding.kind}\` ${findingLocation(finding)} — ${inline(finding.summary)}`,
		),
	];
}

/** One external analysis's rendered block: heading, provenance, coverage, reason and bounded evidence. */
function analysisBlock(analysis: ReportAnalysis, findingLimit: number): string[] {
	const lines = [
		`### ${analysis.provider.id} — ${STATE_LABELS[analysis.state]}`,
		"",
		`- provenance: ${provenance(analysis)}`,
	];
	if (analysis.state === "unrequested") {
		lines.push(`- ${NOT_REQUESTED_NOTE}`);
		return lines;
	}
	if (analysis.reason !== undefined) lines.push(`- reason: ${analysis.reason}`);
	const summary = coverageSummary(analysis);
	if (summary !== undefined) lines.push(`- coverage: ${summary}`);
	lines.push(...cloneBullets(analysis));
	const metrics = metricBullet(analysis);
	if (metrics !== undefined) lines.push(metrics);
	lines.push(...findingBullets(analysis, findingLimit));
	return lines;
}

/**
 * The optional-provider evidence section of the Markdown report: one block
 * per carried external analysis (in the report's provider-id order — never
 * re-ranked), headed by the overall evidence completeness and its
 * independence from the score, and closed by the pointer to the fuller JSON
 * evidence. Returns an empty array — and the Markdown report stays
 * byte-identical — when the report carries no external analysis (a default
 * native-only audit, or a pre-provider schema 1.0.0 artifact).
 */
export function providerAnalysesSection(report: AuditReport, findingLimit: number): string[] {
	const analyses = carriedAnalyses(report).filter(
		(analysis) => analysis.provider.kind === "external",
	);
	if (analyses.length === 0) return [];
	const lines = [`## ${PROVIDER_SECTION_TITLE}`, "", ...evidenceCompletenessLines(report)];
	for (const analysis of analyses) {
		lines.push("", ...analysisBlock(analysis, findingLimit));
	}
	lines.push("", FULL_EVIDENCE_POINTER);
	return lines;
}
