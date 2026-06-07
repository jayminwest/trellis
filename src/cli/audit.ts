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
import { accessSync, constants, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
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
	type OutputFormat,
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
	/**
	 * Report file target: a `string` path (`--output <path>`), `false`
	 * (`--no-output`, skip writing), or `undefined` (default — write a timestamped
	 * markdown report under `.trellis/`). Format is inferred from an explicit
	 * path's extension, overridable by `--json`/`--md`.
	 */
	output?: string | false;
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
			"write the report to this file (.json/.md inferred; --json/--md override)",
		)
		.option("--no-output", "do not write a report file (default writes .trellis/audit-<ts>.md)")
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
	// Validate the report target up front so a bad `--output` fails immediately,
	// before the (minutes-long) investigation pass burns time and tokens.
	const reportPlan = planReportTarget(opts.output, format);
	const piBin = process.env.TRELLIS_PI_BIN?.trim();
	const quiet = opts.quiet === true;
	const reporter = createProgressReporter({
		quiet,
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
		...(reporter ? { onProgress: reporter.onProgress } : {}),
	});
	reporter?.finish();
	const rendered = {
		human: renderTerminal(report, rubric),
		json: report,
		md: renderMarkdown(report, rubric),
	} satisfies Rendered;
	// stdout always honours --json/--md (default human) so piping stays stable;
	// the report file is a separate artifact. `--no-output` (plan === null) skips
	// it; an explicit file path uses its extension/override; a directory target
	// (incl. the default `.trellis/`) gets a timestamped report so history is kept.
	if (reportPlan) {
		const path = finalizeReportPath(reportPlan, report.scoredAt);
		writeReportFile(path, reportPlan.format, rendered);
		if (!quiet) process.stderr.write(`trellis: report written to ${path}\n`);
	}
	emit(format, rendered);
	const assessment = assessReport(report, rubric, policy);
	if (assessment.failed) throw new FailOnExit(assessment.reasons);
}

/**
 * A validated report destination resolved *before* the audit runs: either a
 * fixed file `path`, or a `dir` to drop a timestamped report into (an explicit
 * directory target, or the default `.trellis/`). The concrete filename for a
 * `dir` plan is finalized later (it needs the run's `scoredAt`).
 */
type ReportPlan =
	| { kind: "file"; path: string; format: OutputFormat }
	| { kind: "dir"; dir: string; format: OutputFormat };

/**
 * Resolve and validate where the report file will be written, *before* the
 * expensive audit pass. `--no-output` ({@link output} `=== false`) returns
 * `null`. An explicit path that names an existing directory becomes a directory
 * target (so `--output .` drops a timestamped report there instead of failing
 * with `EISDIR`); otherwise it is a file path whose parent directory must
 * already exist and be writable. With no flag, a timestamped markdown report
 * lands under `.trellis/`. Throws {@link CliError} up front on an unwritable
 * target so the failure costs no investigation time.
 */
function planReportTarget(
	output: string | false | undefined,
	format: OutputFormat,
): ReportPlan | null {
	if (output === false) return null;
	if (typeof output === "string") {
		if (isDirectory(output)) {
			assertWritableDir(output, output);
			return { kind: "dir", dir: output, format: format === "json" ? "json" : "md" };
		}
		assertWritableDir(dirname(output) || ".", output);
		return { kind: "file", path: output, format: formatForPath(output, format) };
	}
	const dir = join(process.cwd(), ".trellis");
	mkdirSync(dir, { recursive: true });
	return { kind: "dir", dir, format: "md" };
}

/** Turn a validated {@link ReportPlan} into the concrete file path to write. */
function finalizeReportPath(plan: ReportPlan, scoredAt: string): string {
	if (plan.kind === "file") return plan.path;
	const ext = plan.format === "json" ? "json" : "md";
	return join(plan.dir, `audit-${fileStamp(scoredAt)}.${ext}`);
}

/** Whether `path` exists and is a directory (an `EISDIR` write target). */
function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** Assert `dir` exists and is writable, else raise a {@link CliError} naming `target`. */
function assertWritableDir(dir: string, target: string): void {
	if (!existsSync(dir)) {
		throw new CliError(`could not write report to ${target}: directory ${dir} does not exist`);
	}
	try {
		accessSync(dir, constants.W_OK);
	} catch {
		throw new CliError(`could not write report to ${target}: ${dir} is not writable`);
	}
}

/** Turn an ISO timestamp into a filesystem-safe stamp (`2026-06-07T16-30-59`). */
function fileStamp(scoredAt: string): string {
	return scoredAt
		.replace(/:/g, "-")
		.replace(/\.\d+Z$/, "")
		.replace(/Z$/, "");
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
