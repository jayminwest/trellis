/**
 * `trellis audit <repo-path>` — the end-to-end audit (SPEC §12, §13.1). Thin per
 * SPEC §13.1: it loads the rubric once, calls the core {@link runAudit} service
 * (store lifecycle + the audit pipeline + persistence), shapes the three output
 * variants, then applies the {@link assessReport} exit-code policy. It computes
 * nothing itself — the level, scores, per-criterion entries, and the pass/fail
 * verdict all come from core.
 *
 * Agent-discovery criteria are graded by the investigation layer (SPEC §7.3);
 * `--no-cache` forces re-investigation and a missing/incompatible Pi degrades
 * those criteria to `no-detector`. Each run persists to the central SQLite
 * history (SPEC §6.4) unless `--no-persist` is given; `--db` overrides the DB
 * location. `TRELLIS_PI_BIN` overrides the `pi` binary the provider spawns.
 * `--canonical <v>` opts the run into canonical-config drift (SPEC §10), folded
 * into `report.drift`.
 *
 * Exit codes (SPEC §12): `0` clean; `2` when `--fail-on` trips (default: a gate
 * criterion fails OR drift is detected); `1` on an operational error. `--fail-on
 * level` compares `report.level` against `--min-level` (default 3).
 */
import type { Command } from "commander";
import { Option } from "commander";
import { assessReport, renderMarkdown, renderTerminal, runAudit } from "../report/index.ts";
import { loadRubric, type Rubric, RubricError } from "../rubric/index.ts";
import { failPolicy } from "./fail-on.ts";
import {
	CliError,
	EXIT,
	emit,
	FailOnExit,
	formatForPath,
	type Rendered,
	resolveFormat,
	writeReportFile,
} from "./output.ts";
import { createProgressReporter } from "./progress.ts";

/** Local options for the audit command, merged with the global format flags. */
interface AuditCliOptions {
	json?: boolean;
	md?: boolean;
	cache?: boolean;
	rubricVersion?: string;
	canonical?: string;
	/** SQLite history path; defaults to `TRELLIS_DB` env or `~/.trellis/trellis.db`. */
	db?: string;
	/** Skip persisting this run to the central history. */
	persist?: boolean;
	/** Exit-code policy (SPEC §12). */
	failOn?: string;
	minLevel?: string;
	/** Write the report to this file (format inferred from extension, overridable by --json/--md). */
	output?: string;
	/** Suppress progress lines on stderr. */
	quiet?: boolean;
	/** Per-detector / per-session-message progress detail on stderr. */
	verbose?: boolean;
	/** Hidden: load an alternate rubric directory (used by tests/fixtures). */
	rubricDir?: string;
}

/** Register the `audit` subcommand on `program`. */
export function registerAudit(program: Command): void {
	program
		.command("audit")
		.argument("<repo-path>", "path to the repository to score")
		.description("score one repo; print scorecard")
		.option("--no-cache", "force re-investigation (ignore cached findings)")
		.option("--rubric-version <v>", "pin the rubric version (informational)")
		.option("--canonical <v>", "pin the canonical standards version")
		.option("--db <path>", "SQLite history path (default: $TRELLIS_DB or ~/.trellis/trellis.db)")
		.option("--no-persist", "do not write this run to the central history")
		.addOption(
			new Option(
				"--fail-on <mode>",
				"exit non-zero on: gate|drift|level|none (default: gate or drift)",
			).choices(["gate", "drift", "level", "none"]),
		)
		.option("--min-level <n>", "minimum level for --fail-on level (1–5, default 3)")
		.option(
			"--output <path>",
			"write the report to a file (.json/.md inferred; --json/--md override)",
		)
		.option("--quiet", "suppress progress output on stderr")
		.option("--verbose", "show per-detector and per-message progress on stderr")
		.addOption(new Option("--rubric-dir <path>", "load an alternate rubric directory").hideHelp())
		.action(function (this: Command, repoPath: string) {
			return runAuditCommand(repoPath, this.optsWithGlobals() as AuditCliOptions);
		});
}

/** Load the rubric, run the core audit, emit the report, then apply the exit-code policy. */
async function runAuditCommand(repoPath: string, opts: AuditCliOptions): Promise<void> {
	const format = resolveFormat(opts);
	const policy = failPolicy(opts);
	const rubric = loadRubricOrThrow(opts.rubricDir);
	const piBin = process.env.TRELLIS_PI_BIN?.trim();
	const onProgress = createProgressReporter({
		quiet: opts.quiet === true,
		verbose: opts.verbose === true,
		isTTY: Boolean(process.stderr.isTTY),
	});
	const report = await runAudit(repoPath, {
		rubric,
		...(opts.rubricVersion ? { rubricVersion: opts.rubricVersion } : {}),
		...(opts.canonical ? { canonical: opts.canonical } : {}),
		...(opts.cache === false ? { noCache: true } : {}),
		...(opts.db ? { db: opts.db } : {}),
		...(opts.persist === false ? { persist: false } : {}),
		...(piBin ? { piBin } : {}),
		...(onProgress ? { onProgress } : {}),
	});
	const rendered = {
		human: renderTerminal(report, rubric),
		json: report,
		md: renderMarkdown(report, rubric),
	} satisfies Rendered;
	// With --output the file gets the (inferred/overridden) format and stdout
	// keeps the readable terminal summary; otherwise stdout gets the chosen format.
	if (opts.output) {
		writeReportFile(opts.output, formatForPath(opts.output, format), rendered);
		emit("human", rendered);
	} else {
		emit(format, rendered);
	}
	const assessment = assessReport(report, rubric, policy);
	if (assessment.failed) throw new FailOnExit(assessment.reasons);
}

/** Load the rubric, converting a loader {@link RubricError} into a {@link CliError}. */
function loadRubricOrThrow(dir: string | undefined): Rubric {
	try {
		return loadRubric(dir);
	} catch (error) {
		if (error instanceof RubricError) {
			throw new CliError(error.message, EXIT.ERROR, { id: error.id, file: error.file });
		}
		throw error;
	}
}
