/**
 * `trellis audit <path>` — measure + score one TypeScript workspace and print
 * its sloppiness report (SPEC §12, §13.1). Thin per SPEC §13.1: parse flags,
 * call the core {@link runWorkspaceAudit} service (configuration → the
 * deterministic audit core → baseline resolution → policy assessment →
 * opt-in history), shape the three output variants, then map the policy
 * assessment onto the exit-code contract. It computes nothing itself.
 *
 * **Stateless by default (SPEC §8, §10):** no database is opened and no
 * report file is written unless the operator asks. `--history` records the
 * run in the central SQLite history (`--db` overrides its location) and,
 * absent `--baseline`, resolves the baseline from the latest compatible
 * stored run; `--out <file>` writes the report artifact (format from the
 * extension, overridable by `--json`/`--md`). Policy is declarative
 * (SPEC §6.5): the `policy` block of the workspace's `trellis.yaml` — or an
 * explicit `--config <file>` — gates the run.
 *
 * Exit codes (SPEC §9): `0` clean; `2` when a configured policy trips (the
 * report is still emitted to stdout; the reasons go to stderr); `1` on an
 * operational error (an unreadable workspace, invalid configuration, or an
 * unloadable baseline artifact).
 *
 * Retired knobs (SPEC §14) fail fast with an actionable "removed in the
 * deterministic pivot" error — never a silent ignore: readiness-era
 * `--rubric-version`, `--min-level`, `--fail-on`, `--canonical`,
 * `--no-persist`, `--output`/`--no-output`, and investigation-era
 * `--no-cache` / `TRELLIS_PI_BIN`.
 */
import { accessSync, constants, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Command } from "commander";
import { Option } from "commander";
import { runWorkspaceAudit, type WorkspaceAuditResult } from "../audit/index.ts";
import type { PolicyAssessment } from "../compare/index.ts";
import { legacyConfigMessage, retiredReadinessMessage } from "../legacy.ts";
import { renderAuditMarkdown, renderAuditTerminal } from "../report/index.ts";
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
	/** Write the report artifact to this file (`.json`/`.md` inferred; `--json`/`--md` override). */
	out?: string;
	/** Saved baseline report artifact to compare against (SPEC §9). */
	baseline?: string;
	/** Explicit `trellis.yaml` path; default discovers at the workspace root. */
	config?: string;
	/** Opt-in persistence to the central SQLite history (SPEC §10). */
	history?: boolean;
	/** SQLite history path (requires `--history`); defaults to `$TRELLIS_DB` or `~/.trellis/trellis.db`. */
	db?: string;
	/** Suppress progress lines on stderr. */
	quiet?: boolean;
	/** Per-analyzer progress detail on stderr. */
	verbose?: boolean;
	/** Retired (`--no-cache`): kept as a hidden flag so passing it errors actionably. */
	cache?: boolean;
	/** Retired (`--no-persist`): audits are stateless by default now. */
	persist?: boolean;
	/** Retired (`--output`/`--no-output`): renamed `--out`; no default report file remains. */
	output?: string | false;
	/** Retired readiness-era flags. */
	rubricVersion?: string;
	rubricDir?: string;
	canonical?: string;
	failOn?: string;
	minLevel?: string;
}

/** Register the `audit` subcommand on `program`. */
export function registerAudit(program: Command): void {
	program
		.command("audit")
		.argument("<path>", "path to the TypeScript workspace to measure")
		.description("measure + score one workspace; print the sloppiness report")
		.option("--out <file>", "write the report artifact to this file (.json/.md inferred)")
		.option("--baseline <report.json>", "compare against a saved report artifact (SPEC §9)")
		.option("--config <file>", "explicit trellis.yaml (default: discovered at the workspace root)")
		.option("--history", "record the run in the central history (opt-in; default stateless)")
		.option("--db <path>", "SQLite history path (requires --history)")
		.option("--quiet", "suppress progress output on stderr")
		.option("--verbose", "show per-analyzer progress on stderr")
		// Retired flags: hidden, and each fails fast with an actionable error.
		.addOption(new Option("--no-cache", "retired: no investigation pass remains").hideHelp())
		.addOption(new Option("--no-persist", "retired: audits are stateless by default").hideHelp())
		.addOption(new Option("--output <path>", "retired: renamed --out").hideHelp())
		.addOption(new Option("--no-output", "retired: no default report file remains").hideHelp())
		.addOption(new Option("--rubric-version <v>", "retired: the rubric is gone").hideHelp())
		.addOption(new Option("--rubric-dir <path>", "retired: the rubric is gone").hideHelp())
		.addOption(new Option("--canonical <v>", "retired: drift is a separate capability").hideHelp())
		.addOption(new Option("--fail-on <mode>", "retired: policy is declarative now").hideHelp())
		.addOption(new Option("--min-level <n>", "retired: levels are gone").hideHelp())
		.action(function (this: Command, repoPath: string) {
			return runAuditCommand(repoPath, this.optsWithGlobals() as AuditCliOptions);
		});
}

/**
 * Fail fast on retired flags (SPEC §14): each names its replacement instead
 * of being silently ignored. Runs before any measurement work.
 */
function rejectRetiredFlags(opts: AuditCliOptions): void {
	if (opts.cache === false) throw new CliError(legacyConfigMessage("--no-cache"));
	if (process.env.TRELLIS_PI_BIN?.trim()) {
		throw new CliError(legacyConfigMessage("TRELLIS_PI_BIN"));
	}
	if (opts.persist === false) {
		throw new CliError(
			"--no-persist no longer exists: audits are stateless by default now (SPEC §8, §10) — " +
				"drop the flag, or pass --history to record the run.",
		);
	}
	if (opts.output !== undefined) {
		throw new CliError(
			"--output/--no-output no longer exist: audits write no report file by default now — " +
				"use --out <file> to request one.",
		);
	}
	if (opts.canonical !== undefined) {
		throw new CliError(
			"--canonical no longer exists on audit: canonical drift is a separate capability " +
				"that never enters the sloppiness index (SPEC §11) — use `trellis drift`.",
		);
	}
	if (opts.failOn !== undefined) {
		throw new CliError(
			"--fail-on no longer exists: failure policies are declarative now — the policy block " +
				"of trellis.yaml (SPEC §6.5, §9) gates the run, and a tripped policy exits 2.",
		);
	}
	if (opts.rubricVersion !== undefined)
		throw new CliError(retiredReadinessMessage("--rubric-version"));
	if (opts.rubricDir !== undefined) throw new CliError(retiredReadinessMessage("--rubric-dir"));
	if (opts.minLevel !== undefined) throw new CliError(retiredReadinessMessage("--min-level"));
}

/** Flatten a tripped {@link PolicyAssessment} into one stderr line per failed reason. */
function policyReasonLines(assessment: PolicyAssessment): string[] {
	const lines: string[] = [];
	for (const result of assessment.results) {
		if (result.status !== "fail") continue;
		for (const reason of result.reasons) {
			lines.push(`policy ${result.policy} failed: ${reason.message}`);
		}
	}
	return lines.length > 0 ? lines : ["a configured policy failed"];
}

/** Assert the parent directory of an `--out` target exists and is writable (fail fast). */
function assertWritableTarget(path: string): void {
	const dir = dirname(path) || ".";
	if (!existsSync(dir)) {
		throw new CliError(`could not write report to ${path}: directory ${dir} does not exist`);
	}
	try {
		accessSync(dir, constants.W_OK);
	} catch {
		throw new CliError(`could not write report to ${path}: ${dir} is not writable`);
	}
}

/**
 * Call the core audit service, mapping every failure onto the operational
 * exit (SPEC §9): the audit could not run, nothing was emitted — exit 1 with
 * the reason. The progress line is always cleared on the way out.
 */
async function runService(
	repoPath: string,
	opts: AuditCliOptions,
	reporter: ReturnType<typeof createProgressReporter>,
): Promise<WorkspaceAuditResult> {
	try {
		return await runWorkspaceAudit(repoPath, {
			...(opts.config ? { configPath: opts.config } : {}),
			...(opts.baseline ? { baselinePath: opts.baseline } : {}),
			...(opts.history === true ? { history: true } : {}),
			...(opts.db ? { db: opts.db } : {}),
			...(reporter ? { onProgress: reporter.onProgress } : {}),
		});
	} catch (error) {
		if (error instanceof CliError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new CliError(message, EXIT.ERROR);
	} finally {
		reporter?.finish();
	}
}

/** Run the core audit service, emit the report, then apply the policy exit-code contract. */
async function runAuditCommand(repoPath: string, opts: AuditCliOptions): Promise<void> {
	const format = resolveFormat(opts);
	rejectRetiredFlags(opts);
	// Validate the report target up front so a bad `--out` fails immediately,
	// before the measurement pass runs.
	if (opts.out !== undefined) assertWritableTarget(opts.out);
	const quiet = opts.quiet === true;
	const reporter = createProgressReporter({
		quiet,
		verbose: opts.verbose === true,
		isTTY: Boolean(process.stderr.isTTY),
	});
	const result = await runService(repoPath, opts, reporter);
	const rendered = {
		human: renderAuditTerminal(result.report),
		json: result.report,
		md: renderAuditMarkdown(result.report),
	} satisfies Rendered;
	// stdout always honours --json/--md (default human) so piping stays stable;
	// `--out` writes a separate artifact in its extension's format.
	if (opts.out !== undefined) {
		writeReportFile(opts.out, formatForPath(opts.out, format), rendered);
		if (!quiet) process.stderr.write(`trellis: report written to ${opts.out}\n`);
	}
	emit(format, rendered);
	if (result.policy.failed) throw new FailOnExit(policyReasonLines(result.policy));
}
