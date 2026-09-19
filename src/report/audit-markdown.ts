/** Render the native audit report with bounded findings and traceable score contributions. */
import type { AuditReport, Finding } from "../contract/index.ts";
import {
	boundFindings,
	coverageRows,
	DEFAULT_HOTSPOT_LIMIT,
	findingLocation,
	formatLocation,
	formatMetric,
	hotspotFindings,
	otherFindings,
	repoLabel,
	scoreHeadline,
	sortedMetrics,
} from "./audit-format.ts";
import { providerAnalysesSection } from "./audit-markdown-providers.ts";

/** Options for {@link renderAuditMarkdown}. */
export interface AuditMarkdownOptions {
	/** Maximum ranked hotspots shown (bounded summary); the total is always printed. */
	hotspotLimit?: number;
	/** Maximum non-hotspot findings shown; the total is always printed. */
	findingLimit?: number;
	/** Maximum provider findings shown per optional analysis; the total is always printed. */
	providerFindingLimit?: number;
}

/** Escape a value for a table cell (pipes and newlines would break the table). */
function cell(text: string): string {
	return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

/** Render the bounded finding table shared by the hotspot and findings sections. */
function findingRows(findings: readonly Finding[]): string[] {
	return findings.map(
		(finding) =>
			`| ${cell(finding.kind)} | ${cell(findingLocation(finding))} | ${cell(finding.summary)} |`,
	);
}

/** Render a §6.4 audit report as a bounded Markdown summary. */
export function renderAuditMarkdown(
	report: AuditReport,
	options: AuditMarkdownOptions = {},
): string {
	const hotspotLimit = options.hotspotLimit ?? DEFAULT_HOTSPOT_LIMIT;
	const findingLimit = options.findingLimit ?? DEFAULT_HOTSPOT_LIMIT;

	const lines: string[] = [
		`# trellis audit — ${repoLabel(report)}`,
		"",
		`**${scoreHeadline(report)}** · completeness: ${report.completeness}`,
		"",
		"## Source coverage",
		"",
		"| scope | files | sloc | note |",
		"|---|---|---|---|",
	];
	for (const row of coverageRows(report.sourceCoverage)) {
		lines.push(`| ${row.scope} | ${row.files} | ${row.sloc ?? ""} | ${cell(row.note ?? "")} |`);
	}

	lines.push(
		"",
		"## Score contributions",
		"",
		"Every point traces to raw metrics on this report (SPEC §7).",
		"",
		"| dimension | points | traceable metrics |",
		"|---|---|---|",
	);
	for (const contribution of report.score.contributions) {
		lines.push(
			`| ${contribution.dimension} | ${contribution.points} | ${contribution.metricIds.join(", ")} |`,
		);
	}

	lines.push("", "## Metrics", "", "| metric | value |", "|---|---|");
	for (const metric of sortedMetrics(report)) {
		lines.push(`| ${metric.id} | ${cell(formatMetric(metric))} |`);
	}

	const hotspots = boundFindings(hotspotFindings(report), hotspotLimit);
	lines.push("", `## Hotspots (top ${hotspots.shown.length} of ${hotspots.total})`, "");
	if (hotspots.shown.length === 0) {
		lines.push("No ranked hotspots.");
	} else {
		lines.push("| kind | location | summary |", "|---|---|---|", ...findingRows(hotspots.shown));
	}

	const others = boundFindings(otherFindings(report), findingLimit);
	if (others.total > 0) {
		lines.push("", `## Findings (${others.shown.length} of ${others.total})`, "");
		lines.push("| kind | location | summary |", "|---|---|---|", ...findingRows(others.shown));
	}

	lines.push(
		"",
		"## Safeguards",
		"",
		"Configuration evidence only — safeguards never enter the sloppiness index (SPEC §5.5).",
		"",
		"| safeguard | evidence | locations | notes |",
		"|---|---|---|---|",
	);
	for (const result of report.safeguards) {
		const locations = result.locations
			.map((location) => formatLocation(location.path, location.range))
			.join(", ");
		lines.push(
			`| ${result.id} | ${result.evidence} | ${cell(locations)} | ${cell(result.notes ?? "")} |`,
		);
	}

	const providerLines = providerAnalysesSection(
		report,
		options.providerFindingLimit ?? DEFAULT_HOTSPOT_LIMIT,
	);
	if (providerLines.length > 0) {
		lines.push("", ...providerLines);
	}

	return lines.join("\n");
}
