/**
 * Report layer — two surfaces while the pivot (SPEC §14) completes:
 *
 * - **The §6.4 metric-report renderers** (SPEC §12, trellis-a059):
 *   {@link renderAuditTerminal} / {@link renderAuditJson} /
 *   {@link renderAuditMarkdown} present the deterministic core's
 *   {@link import("../contract/index.ts").AuditReport} — bounded terminal and
 *   Markdown summaries, the full structured JSON document — over the shared
 *   presentation helpers in `audit-format.ts`. {@link auditFixture} builds
 *   the five render-fixture repositories through the real core.
 * - The legacy §6.3 readiness surface ({@link auditRepo}, the {@link Report}
 *   shape, {@link rollupByCategory}/{@link tally}, and the legacy
 *   renderers) — transitional; it leaves with the rubric in the staged plan.
 */

export {
	type Assessment,
	activeChecks,
	assessReport,
	DEFAULT_MIN_LEVEL,
	FAIL_ON_MODES,
	type FailOnMode,
	type FailPolicy,
	failingGateIds,
} from "./assess.ts";
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
export { type AuditOptions, auditRepo, SKIPPED_VIA_TARGETS } from "./build.ts";
export { changesSinceLastRun, criterionStatus, snapshot } from "./changes.ts";
export {
	DEFAULT_DELTA_LIMIT,
	renderComparisonMarkdown,
	renderComparisonTerminal,
	renderPolicyMarkdown,
	renderPolicyTerminal,
} from "./comparison.ts";
export { renderJson } from "./json.ts";
export { renderMarkdown } from "./markdown.ts";
export type { AuditEvent, AuditPhase, AuditProgress } from "./progress.ts";
export { type CategoryRollup, pct, rollupByCategory, type Tally, tally } from "./rollup.ts";
export { type AuditRunOptions, runAudit } from "./run.ts";
export { renderTerminal } from "./terminal.ts";
export type {
	AppDescriptor,
	ChangesSinceLastRun,
	CriterionSnapshot,
	CriterionStatus,
	CriterionTransition,
	Report,
	TransitionKind,
} from "./types.ts";
