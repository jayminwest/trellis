/** Audit history projections and renderers over the central SQLite store. */
export {
	type AuditRepoHistory,
	type AuditRunPoint,
	type AuditSnapshotEntry,
	buildHistory,
	type HistoryOptions,
	type HistoryReport,
} from "./dashboard.ts";
export { renderHistoryMarkdown, renderHistoryTerminal } from "./render.ts";
export { buildReport, type ReportRunOptions } from "./run.ts";
