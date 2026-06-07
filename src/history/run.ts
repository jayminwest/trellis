/**
 * History service (SPEC §13.1) — the store-lifecycle-wrapped dashboard
 * entrypoint the CLI and SDK both fold. {@link buildHistory} is the pure
 * projection over an open store; {@link buildReport} adds the open/close wiring
 * that was inline in the CLI. The SDK's `report()` is a direct call to it.
 */
import { openStore } from "../store/index.ts";
import { buildHistory, type HistoryOptions, type HistoryReport } from "./dashboard.ts";

/** Query for {@link buildReport} — the dashboard scope plus the store location. */
export interface ReportRunOptions extends HistoryOptions {
	/** SQLite history path; defaults to `$TRELLIS_DB` or `~/.trellis/trellis.db`. */
	db?: string;
}

/**
 * Open the central store and project the run-history dashboard for the queried
 * scope (SPEC §11). `repo` narrows to one target; `since` floors the run window.
 */
export function buildReport(opts: ReportRunOptions = {}): HistoryReport {
	const store = openStore(opts.db);
	try {
		return buildHistory(store, {
			...(opts.repo ? { repo: opts.repo } : {}),
			...(opts.since ? { since: opts.since } : {}),
		});
	} finally {
		store.close();
	}
}
