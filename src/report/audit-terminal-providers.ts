/**
 * Terminal rendering of the report's optional-provider evidence area (SPEC
 * §6.6, §16.2 — plan `pl-43c5` step 16, trellis-fc9c).
 *
 * The block appears **only when the report actually carries an external
 * analysis** — a default native-only audit renders byte-identically, with no
 * provider noise. When it appears it is a distinct engineering-evidence
 * section, never conflated with the score contributions:
 *
 * - every carried analysis is shown with its state (distinguishing *not
 *   requested* from a completed analysis that found nothing), its concise
 *   provenance (mode, pinned tool and adapter versions), what it actually
 *   covered (analyzed files against its selection — asserted coverage, never
 *   inferred from an exit status) and, when it did not run or ran partially,
 *   its located reason. An unavailable/incomplete/deferred analysis is
 *   explained as such — never rendered as a clean zero.
 * - duplication evidence explains its own units: pairs (the provider's unit,
 *   counted per match mode) and groups, explicitly never interchangeable
 *   with the native detector's clone groups and never summed with them.
 * - the block states the overall evidence completeness — an independent
 *   quantity from score completeness (§16.2): an optional analysis's
 *   failure never labels the native score partial; the headline keeps
 *   carrying that verdict on its own.
 * - summaries stay bounded and preserve the report's deterministic order
 *   (analyses in provider-id order, findings in the entry's carried order —
 *   never re-ranked here), and the block points at the JSON report for the
 *   full evidence.
 */
import {
	type AuditReport,
	CLONE_MATCH_MODES,
	carriedAnalyses,
	type ObservedCoverage,
	type ReportAnalysis,
	SOURCE_SETS,
} from "../contract/index.ts";
import { boundFindings, findingLocation, formatMetric } from "./audit-format.ts";

/** The section title: advisory engineering evidence, explicitly unscored (§16.5). */
const SECTION_TITLE =
	"provider analyses (optional engineering evidence — never folded into the score)";

/** Where the fuller evidence lives: the JSON report carries the complete evidence area. */
const JSON_EVIDENCE_POINTER =
	"full evidence: the JSON report (--json) carries every analysis's selection, clone members, diagnostics and metrics";

/**
 * State labels: `unrequested` reads as *not requested* — an explicit absence,
 * never confusable with a completed analysis that found nothing.
 */
const STATE_LABELS = {
	unrequested: "not requested",
	unavailable: "unavailable",
	unsupported: "unsupported",
	incomplete: "incomplete",
	complete: "complete",
} as const;

/** Right-pad `s` to `width` for fixed-width columns. */
function pad(s: string, width: number): string {
	return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/** Pluralize `noun` for `count`. */
function plural(noun: string, count: number): string {
	return `${noun}${count === 1 ? "" : "s"}`;
}

/** The overall-evidence line (§16.2): visible whether or not anything failed. */
function overallEvidenceLine(report: AuditReport): string {
	if (report.schemaVersion !== "1.1.0") {
		throw new Error("external provider evidence requires an evidence-carrying (1.1.0) report");
	}
	return report.evidence.completeness === "complete"
		? "  evidence: complete — every carried analysis ran over its full selection"
		: "  evidence: incomplete — at least one analysis did not run or ran partially (see each entry's reason)";
}

/** One analysis's concise provenance: the mode it ran under and its pinned versions. */
function provenance(analysis: ReportAnalysis): string {
	return (
		`mode ${analysis.provider.mode} · tool ${analysis.provider.toolVersion} · ` +
		`adapter ${analysis.provider.adapterVersion}`
	);
}

/** What an analysis actually covered, against its selection (asserted, never exit-status-inferred). */
function coverageLine(analysis: ReportAnalysis): string {
	const coverage: ObservedCoverage = analysis.observedCoverage ?? {
		analyzedFiles: [],
		diagnostics: [],
		unsupported: [],
	};
	const selected = analysis.analysis?.selection.files.length ?? coverage.analyzedFiles.length;
	let line =
		`    coverage: analyzed ${coverage.analyzedFiles.length} of ${selected} selected ` +
		plural("file", selected);
	const bySourceSet = coverage.bySourceSet;
	const sets = SOURCE_SETS.filter((set) => bySourceSet?.[set] !== undefined).map(
		(set) => `${set} ${bySourceSet?.[set]}`,
	);
	if (sets.length > 0) line += ` (${sets.join(" · ")})`;
	if (coverage.diagnostics.length > 0) {
		line += ` · ${coverage.diagnostics.length} ${plural("diagnostic", coverage.diagnostics.length)}`;
	}
	if (coverage.unsupported.length > 0) {
		line += ` · ${coverage.unsupported.length} unsupported ${plural("file", coverage.unsupported.length)}`;
	}
	return line;
}

/** Pair and group counts, by match mode — distinct units, never summed (§16.5 clone-evidence contract). */
function cloneEvidenceLines(analysis: ReportAnalysis): string[] {
	const evidence = analysis.cloneEvidence;
	if (evidence === undefined) return [];
	const pairs = evidence.filter((clone) => clone.kind === "pair");
	const groups = evidence.filter((clone) => clone.kind === "group");
	const byMode = CLONE_MATCH_MODES.map(
		(mode) => `${mode}: ${pairs.filter((pair) => pair.matchMode === mode).length}`,
	);
	return [
		`    clone evidence: ${pairs.length} ${plural("pair", pairs.length)} (${byMode.join(" · ")}) · ` +
			`${groups.length} ${plural("group", groups.length)} — provider pairs and native clone groups are ` +
			"distinct units, never summed",
		"    match modes: exact = identical text · normalized = renamed identifiers · " +
			"near = similar text (pair-only, never grouped)",
	];
}

/** The entry's namespaced metrics, rendered with the shared metric formatter (§6.1). */
function metricLines(analysis: ReportAnalysis): string[] {
	const metrics = analysis.metrics;
	if (metrics === undefined || metrics.length === 0) return [];
	return [
		`    metrics: ${metrics.map((metric) => `${metric.id} = ${formatMetric(metric)}`).join(" · ")}`,
	];
}

/** The entry's findings: bounded, in the report's deterministic order (never re-ranked here). */
function findingLines(analysis: ReportAnalysis, limit: number): string[] {
	const findings = analysis.findings ?? [];
	if (findings.length === 0) {
		// A completed analysis with no findings is an explicit positive result —
		// never the same silence as a provider that never ran.
		return analysis.state === "complete"
			? ["    findings: none — the analysis completed and found none"]
			: [];
	}
	const bounded = boundFindings(findings, limit);
	const kindWidth = Math.max(4, ...bounded.shown.map((finding) => finding.kind.length));
	return [
		`    provider findings (${bounded.shown.length} of ${bounded.total})`,
		...bounded.shown.map(
			(finding) =>
				`      ${pad(finding.kind, kindWidth)}  ${findingLocation(finding)} · ${finding.summary}`,
		),
	];
}

/** One external analysis's rendered lines: state, provenance, coverage, reason and bounded evidence. */
function analysisLines(
	analysis: ReportAnalysis,
	idWidth: number,
	stateWidth: number,
	limit: number,
): string[] {
	const lines = [
		`  ${pad(analysis.provider.id, idWidth)}  ` +
			`${pad(STATE_LABELS[analysis.state], stateWidth)}  ${provenance(analysis)}`,
	];
	if (analysis.state === "unrequested") {
		lines.push(
			"    not requested — no analysis ran and no evidence exists " +
				"(a completed analysis that found nothing is a different, positive result)",
		);
		return lines;
	}
	if (analysis.reason !== undefined) lines.push(`    reason: ${analysis.reason}`);
	if (analysis.observedCoverage !== undefined) lines.push(coverageLine(analysis));
	lines.push(...cloneEvidenceLines(analysis));
	lines.push(...metricLines(analysis));
	lines.push(...findingLines(analysis, limit));
	return lines;
}

/**
 * The optional-provider evidence section of the terminal report: one block
 * per carried external analysis (in the report's provider-id order — never
 * re-ranked), headed by the overall evidence completeness and closed by the
 * pointer to the fuller JSON evidence. Returns an empty array — and the
 * terminal report stays byte-identical — when the report carries no
 * external analysis (a default native-only audit).
 */
export function providerAnalysisLines(report: AuditReport, findingLimit: number): string[] {
	const analyses = carriedAnalyses(report).filter(
		(analysis) => analysis.provider.kind === "external",
	);
	if (analyses.length === 0) return [];
	const idWidth = Math.max(6, ...analyses.map((analysis) => analysis.provider.id.length));
	const stateWidth = Math.max(6, ...analyses.map((a) => STATE_LABELS[a.state].length));
	return [
		SECTION_TITLE,
		overallEvidenceLine(report),
		...analyses.flatMap((analysis) => analysisLines(analysis, idWidth, stateWidth, findingLimit)),
		JSON_EVIDENCE_POINTER,
	];
}
