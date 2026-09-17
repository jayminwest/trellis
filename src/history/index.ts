/**
 * History layer (SPEC §10, §11) — the `trellis report` dashboard over the
 * central SQLite history. Public surface: {@link buildHistory} (the
 * surface-agnostic projection the CLI/SDK fold), the {@link HistoryReport}
 * shape and its parts, and the {@link renderHistoryTerminal} /
 * {@link renderHistoryMarkdown} renderers (the JSON projection is the report
 * itself). Sloppiness runs and legacy readiness runs surface in visibly
 * distinct sections and are never trended together (SPEC §10).
 */
export {
	type AuditRepoHistory,
	type AuditRunPoint,
	type AuditSnapshotEntry,
	buildHistory,
	type HistoryOptions,
	type HistoryReport,
	type LegacyRepoEntry,
} from "./dashboard.ts";
export { renderHistoryMarkdown, renderHistoryTerminal } from "./render.ts";
export { buildReport, type ReportRunOptions } from "./run.ts";
