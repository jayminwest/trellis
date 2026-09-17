/**
 * `trellis audit <path>` — the deterministic sloppiness audit (SPEC §12,
 * trellis-9a88). Thin per SPEC §13.1: it parses flags, calls the core
 * {@link runWorkspaceAudit} service (configure → measure → baseline compare →
 * policy → optional history), shapes the three output variants, then maps the
 * policy assessment onto the exit code. It computes nothing itself — the
 * index, metrics, findings, comparison, and policy verdict all come from core.
 *
 * The audit is fully deterministic and offline (SPEC §8): no model, no
 * network, no Git, no project commands, and **stateless by default** — without
 * `--history` it opens no database, and without `--out` it writes no file.
 *
 * Flags (SPEC §12):
 *
 * - `--baseline <report.json>` — compare against a saved report (§9);
 * - `--config <trellis.yaml>` — explicit audit configuration (§6.5);
 * - `--history` / `--db <path>` — opt-in persistence (§10);
 * - `--out <file>` — write the report to a file (format from the extension,
 *   overridable by `--json`/`--md`);
 * - `--quiet` / `--verbose` — progress on stderr.
 *
 * Retired readiness-era flags (`--rubric-version`, `--min-level`, `--fail-on`,
 * `--canonical`, `--no-persist`, `--output`, provider/model/cache knobs, …)
 * fail with an actionable "removed in the deterministic pivot" error (SPEC
 * §12), never a silent ignore.
 *
 * Exit codes (SPEC §9): `0` clean; `2` when the declarative policy (§6.5)
 * trips — the report is still emitted to stdout, the reasons go to stderr;
 * `1` on an operational error (unreadable root, invalid config or baseline).
 */
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Command } from "commander";
import { Option } from "commander";
import {
	type AuditProgress,
	runWorkspaceAudit,
	type WorkspaceAuditResult,
} from "../audit/index.ts";
import { ReportArtifactError } from "../compare/index.ts";
import { AuditConfigError } from "../config/index.ts";
import { LegacyConfigError, legacyConfigMessage } from "../legacy.ts";
import {
	renderAuditMarkdown,
	renderAuditTerminal,
	renderComparisonMarkdown,
	renderComparisonTerminal,
	renderPolicyMarkdown,
	renderPolicyTerminal,
} from "../report/index.ts";
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
	/** A saved JSON report to compare against (SPEC §9). */
	baseline?: string;
	/** Explicit audit configuration file (§6.5); default discovers trellis.yaml at the root. */
	config?: string;
	/** Opt-in history persistence (SPEC §10). */
	history?: boolean;
	/** SQLite history path; only meaningful with `--history`. */
	db?: string;
	/** Report file target (`--out <path>`); absent → no file is written (stateless, §8). */
	out?: string;
	/** Suppress progress lines on stderr. */
	quiet?: boolean;
	/** Per-analyzer progress detail on stderr. */
	verbose?: boolean;
	/* Retired readiness-era flags — kept as hidden options so passing one errors actionably. */
	cache?: boolean;
	rubricVersion?: string;
	rubricDir?: string;
	canonical?: string;
	persist?: boolean;
	failOn?: string;
	minLevel?: string;
	output?: string | false;
}

/** Register the `audit` subcommand on `program`. */
export function registerAudit(program: Command): void {
	program
		.command("audit")
		.argument("<path>", "path to the workspace to audit")
		.description("measure + score TypeScript sloppiness; print the report")
		.option("--baseline <report.json>", "compare against a saved audit report (SPEC §9)")
		.option("--config <trellis.yaml>", "explicit audit configuration file (SPEC §6.5)")
		.option("--history", "persist this run to the SQLite history (opt-in, SPEC §10)")
		.option(
			"--db <path>",
			"SQLite history path (with --history; default: $TRELLIS_DB or ~/.trellis/trellis.db)",
		)
		.option(
			"--out <file>",
			"write the report to this file (.json/.md inferred; --json/--md override)",
		)
		.option("--quiet", "suppress progress output on stderr")
		.option("--verbose", "show per-analyzer progress on stderr")
		.addOption(new Option("--no-cache", "retired: no investigation pass remains").hideHelp())
		.addOption(new Option("--rubric-version <v>", "retired: the rubric is gone").hideHelp())
		.addOption(new Option("--rubric-dir <path>", "retired: the rubric is gone").hideHelp())
		.addOption(new Option("--canonical <v>", "retired: use trellis drift").hideHelp())
		.addOption(new Option("--no-persist", "retired: audits are stateless by default").hideHelp())
		.addOption(new Option("--fail-on <mode>", "retired: policy lives in trellis.yaml").hideHelp())
		.addOption(new Option("--min-level <n>", "retired: levels are gone").hideHelp())
		.addOption(new Option("--output <path>", "retired: renamed to --out").hideHelp())
		.addOption(new Option("--no-output", "retired: the default writes no file").hideHelp())
		.action(function (this: Command, repoPath: string) {
			return runAuditCommand(repoPath, this.optsWithGlobals() as AuditCliOptions);
		});
}

/** `removed in the deterministic pivot` error for one retired flag, with replacement guidance. */
function retiredFlag(name: string, guidance: string): CliError {
	return new CliError(
		`${name} was removed in the deterministic pivot (SPEC §14). ${guidance}`,
		EXIT.ERROR,
	);
}

/** Fail fast with an actionable error when a retired readiness-era flag was passed (SPEC §12). */
function rejectRetiredFlags(opts: AuditCliOptions): void {
	if (opts.cache === false) throw new CliError(legacyConfigMessage("--no-cache"));
	if (process.env.TRELLIS_PI_BIN?.trim()) {
		throw new CliError(legacyConfigMessage("TRELLIS_PI_BIN"));
	}
	if (opts.rubricVersion !== undefined || opts.rubricDir !== undefined) {
		const name = opts.rubricVersion !== undefined ? "--rubric-version" : "--rubric-dir";
		throw retiredFlag(
			name,
			"There is no rubric to pin or load — the sloppiness audit measures TypeScript structure directly. Remove it and re-run.",
		);
	}
	if (opts.canonical !== undefined) {
		throw retiredFlag(
			"--canonical",
			"Canonical drift no longer folds into the audit (SPEC §11) — run `trellis drift <path>` for the separate standards capability. Remove it and re-run.",
		);
	}
	if (opts.failOn !== undefined || opts.minLevel !== undefined) {
		const name = opts.failOn !== undefined ? "--fail-on" : "--min-level";
		throw retiredFlag(
			name,
			"The gate/drift/level policy is gone — failure policies are declarative in trellis.yaml (SPEC §6.5: maxIndex, budgets, regression, failOnNew) and a tripped policy exits 2. Remove it and re-run.",
		);
	}
	if (opts.persist === false) {
		throw retiredFlag(
			"--no-persist",
			"Audits are stateless by default (SPEC §8) — nothing is persisted unless --history is given. Remove it and re-run.",
		);
	}
	if (opts.output !== undefined) {
		throw retiredFlag(
			opts.output === false ? "--no-output" : "--output",
			"Use --out <file> to write a report file — the default audit writes no file (SPEC §8).",
		);
	}
}

/** Run the core audit service, mapping operational failures onto {@link CliError}. */
async function auditOrThrow(
	repoPath: string,
	opts: AuditCliOptions,
	onProgress: AuditProgress | undefined,
): Promise<WorkspaceAuditResult> {
	try {
		return await runWorkspaceAudit(repoPath, {
			...(opts.config ? { configPath: opts.config } : {}),
			...(opts.baseline ? { baselinePath: opts.baseline } : {}),
			...(opts.history ? { history: { ...(opts.db ? { db: opts.db } : {}) } } : {}),
			...(onProgress ? { onProgress } : {}),
		});
	} catch (error) {
		if (
			error instanceof ReportArtifactError ||
			error instanceof AuditConfigError ||
			error instanceof LegacyConfigError
		) {
			throw new CliError(error.message, EXIT.ERROR);
		}
		throw error;
	}
}

/**
 * The baseline-comparison and policy appendix for the human/Markdown views
 * (JSON stdout stays the pure §6.4 report so it can feed a later `--baseline`).
 * Empty when no baseline was given and no policies are configured.
 */
function appendix(result: WorkspaceAuditResult, format: "human" | "md"): string {
	const blocks: string[] = [];
	if (result.comparison) {
		blocks.push(
			format === "md"
				? `## Baseline comparison\n\n${renderComparisonMarkdown(result.comparison)}`
				: `baseline comparison\n-------------------\n${renderComparisonTerminal(result.comparison)}`,
		);
	}
	if (result.policy.results.length > 0) {
		blocks.push(
			format === "md"
				? `## Policy\n\n${renderPolicyMarkdown(result.policy)}`
				: renderPolicyTerminal(result.policy),
		);
	}
	return blocks.length === 0 ? "" : `\n\n${blocks.join("\n\n")}`;
}

/** The failure reasons of a tripped policy, flattened for the stderr contract (SPEC §9). */
function failureReasons(result: WorkspaceAuditResult): string[] {
	return result.policy.results
		.filter((entry) => entry.status === "fail")
		.flatMap((entry) => entry.reasons.map((reason) => reason.message));
}

/** Load config, run the core audit, emit the report, then apply the policy exit code. */
async function runAuditCommand(repoPath: string, opts: AuditCliOptions): Promise<void> {
	const format = resolveFormat(opts);
	// Retired readiness-era knobs fail fast with an actionable message (SPEC §12)
	// — before any measurement work runs.
	rejectRetiredFlags(opts);
	if (opts.db !== undefined && opts.history !== true) {
		throw new CliError(
			"--db only applies with --history: audits are stateless by default (SPEC §8). Add --history to persist this run.",
			EXIT.ERROR,
		);
	}
	// Validate the report target up front so a bad `--out` fails immediately,
	// before the measurement pass runs.
	const reportPlan = planReportTarget(opts.out, format);
	const quiet = opts.quiet === true;
	const reporter = createProgressReporter({
		quiet,
		verbose: opts.verbose === true,
		isTTY: Boolean(process.stderr.isTTY),
	});
	const result = await auditOrThrow(repoPath, opts, reporter?.onProgress);
	reporter?.finish();
	const rendered = {
		human: renderAuditTerminal(result.report) + appendix(result, "human"),
		json: result.report,
		md: renderAuditMarkdown(result.report) + appendix(result, "md"),
	} satisfies Rendered;
	// stdout always honours --json/--md (default human) so piping stays stable;
	// the report file is a separate artifact written only when --out asks for it.
	if (reportPlan) {
		const path = finalizeReportPath(reportPlan, result.report.run?.auditedAt);
		writeReportFile(path, reportPlan.format, rendered);
		if (!quiet) process.stderr.write(`trellis: report written to ${path}\n`);
	}
	emit(format, rendered);
	if (result.policy.failed) throw new FailOnExit(failureReasons(result));
}

/**
 * A validated report destination resolved *before* the audit runs: either a
 * fixed file `path`, or a `dir` to drop a timestamped report into (an explicit
 * directory target). The concrete filename for a `dir` plan is finalized later
 * (it needs the run's `auditedAt`).
 */
type ReportPlan =
	| { kind: "file"; path: string; format: OutputFormat }
	| { kind: "dir"; dir: string; format: OutputFormat };

/**
 * Resolve and validate where `--out` will write, *before* the measurement
 * pass. No `--out` returns `null` — the default audit is stateless (SPEC §8)
 * and writes no file. An explicit path that names an existing directory
 * becomes a directory target (so `--out .` drops a timestamped report there
 * instead of failing with `EISDIR`); otherwise it is a file path whose parent
 * directory must already exist and be writable. Throws {@link CliError} up
 * front on an unwritable target so the failure costs no measurement time.
 */
function planReportTarget(out: string | undefined, format: OutputFormat): ReportPlan | null {
	if (out === undefined) return null;
	if (isDirectory(out)) {
		assertWritableDir(out, out);
		return { kind: "dir", dir: out, format: format === "json" ? "json" : "md" };
	}
	assertWritableDir(dirname(out) || ".", out);
	return { kind: "file", path: out, format: formatForPath(out, format) };
}

/** Turn a validated {@link ReportPlan} into the concrete file path to write. */
function finalizeReportPath(plan: ReportPlan, auditedAt: string | undefined): string {
	if (plan.kind === "file") return plan.path;
	const ext = plan.format === "json" ? "json" : "md";
	return join(plan.dir, `audit-${fileStamp(auditedAt ?? new Date().toISOString())}.${ext}`);
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
function fileStamp(auditedAt: string): string {
	return auditedAt
		.replace(/:/g, "-")
		.replace(/\.\d+Z$/, "")
		.replace(/Z$/, "");
}
