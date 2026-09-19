/** Audit report renderers and shared presentation helpers. */

export {
	auditFixture,
	FIXTURE_KINDS,
	type FixtureKind,
	type FixtureReport,
	seedFixtureRepo,
} from "./audit-fixtures.ts";
export {
	type BoundedFindings,
	boundFindings,
	type CoverageRow,
	coverageRows,
	DEFAULT_HOTSPOT_LIMIT,
	findingLocation,
	formatLocation,
	formatMetric,
	formatNumber,
	HOTSPOT_KINDS,
	hotspotFindings,
	otherFindings,
	repoLabel,
	scoreHeadline,
	sortedMetrics,
} from "./audit-format.ts";
export { renderAuditJson } from "./audit-json.ts";
export { type AuditMarkdownOptions, renderAuditMarkdown } from "./audit-markdown.ts";
export { type AuditTerminalOptions, renderAuditTerminal } from "./audit-terminal.ts";
export {
	type ComparisonRenderOptions,
	renderComparisonMarkdown,
	renderComparisonTerminal,
} from "./compare-render.ts";
