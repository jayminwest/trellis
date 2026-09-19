/** CLI audit history dashboard over the central SQLite store. */
import type { Command } from "commander";
import { Option } from "commander";
import { buildReport, renderHistoryMarkdown, renderHistoryTerminal } from "../history/index.ts";
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

/** Build the dashboard via core and emit the chosen output variant. */
function runReportCommand(opts: ReportCliOptions): void {
	const format = resolveFormat(opts);
	const report = buildReport({
		...(opts.db ? { db: opts.db } : {}),
		...(opts.repo ? { repo: opts.repo } : {}),
		...(opts.since ? { since: opts.since } : {}),
	});
	emit(format, {
		human: renderHistoryTerminal(report),
		json: report,
		md: renderHistoryMarkdown(report),
	} satisfies Rendered);
}
