/**
 * History layer (SPEC §11) — the `trellis report` dashboard over the central
 * SQLite history. Public surface: {@link buildHistory} (the surface-agnostic
 * projection the CLI/SDK fold), the {@link HistoryReport} shape and its parts,
 * and the {@link renderHistoryTerminal} / {@link renderHistoryMarkdown} renderers
 * (the JSON projection is the report itself).
 */
export {
	buildHistory,
	type CriterionTrend,
	type HistoryOptions,
	type HistoryReport,
	type RepoHistory,
	type RunPoint,
	type SnapshotEntry,
	type TrendPoint,
} from "./dashboard.ts";
export { renderHistoryMarkdown, renderHistoryTerminal } from "./render.ts";
export { buildReport, type ReportRunOptions } from "./run.ts";
