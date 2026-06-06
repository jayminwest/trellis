/**
 * `trellis report` — render the run-history dashboard from the central SQLite
 * store (SPEC §11, §12). Thin per SPEC §13.1: open the store, call the core
 * {@link buildHistory} (fleet snapshot + per-repo series, the latest §11 delta,
 * and per-criterion trends), then shape the three output variants. `--repo`
 * narrows to one target; `--since` floors the run window; `--db` overrides the
 * central DB location. Exit is always `0` here — the `--fail-on` contract lands
 * with the SDK exit-code step (trellis-28a5).
 */
import type { Command } from "commander";
import { Option } from "commander";
import { buildHistory, renderHistoryMarkdown, renderHistoryTerminal } from "../history/index.ts";
import { openStore } from "../store/index.ts";
import { emit, type Rendered, resolveFormat } from "./output.ts";

/** Local options for the report command, merged with the global format flags. */
interface ReportCliOptions {
	json?: boolean;
	md?: boolean;
	repo?: string;
	since?: string;
	/** SQLite history path; defaults to `TRELLIS_DB` env or `~/.trellis/trellis.db`. */
	db?: string;
}

/** Register the `report` subcommand on `program`. */
export function registerReport(program: Command): void {
	program
		.command("report")
		.description("render history/dashboard from SQLite")
		.option("--repo <id>", "limit to one target")
		.option("--since <date>", "only runs since this date (ISO-8601)")
		.addOption(new Option("--db <path>", "SQLite history path").hideHelp())
		.action(function (this: Command) {
			runReportCommand(this.optsWithGlobals() as ReportCliOptions);
		});
}

/** Open the store, build the dashboard, and emit the chosen output variant. */
function runReportCommand(opts: ReportCliOptions): void {
	const format = resolveFormat(opts);
	const store = openStore(opts.db);
	try {
		const report = buildHistory(store, {
			...(opts.repo ? { repo: opts.repo } : {}),
			...(opts.since ? { since: opts.since } : {}),
		});
		emit(format, {
			human: renderHistoryTerminal(report),
			json: report,
			md: renderHistoryMarkdown(report),
		} satisfies Rendered);
	} finally {
		store.close();
	}
}
