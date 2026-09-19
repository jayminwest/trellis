/** CLI audit command over the deterministic core service, with opt-in provider evidence. */
import { accessSync, constants, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Command } from "commander";
import {
	runWorkspaceAudit,
	type WorkspaceAuditOptions,
	type WorkspaceAuditResult,
} from "../audit/index.ts";
import type { PolicyAssessment } from "../compare/index.ts";
import { loadAuditConfig, loadAuditConfigFile } from "../config/index.ts";
import type { ProviderSelection } from "../contract/config.ts";
import type { AuditConfig } from "../contract/index.ts";
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
import { providerSelectionFromFlags } from "./provider-flags.ts";

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
	/** Repeatable: one `--provider <id[:mode]>` selection per optional provider (SPEC §16.4). */
	provider?: string[];
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
		.option(
			"--provider <id[:mode]>",
			"select an optional evidence provider (repeatable; per provider it overrides the " +
				"trellis.yaml providers block). The pinned tool must already be installed locally — " +
				"trellis never installs or fetches tools at audit time — and the analysis runs over " +
				"isolated temporary scratch storage trellis owns and cleans up (native audits create " +
				"none). jscpd needs a match mode: --provider jscpd:<exact|normalized|near>",
			(value: string, previous: string[] = []) => [...previous, value],
		)
		.option("--quiet", "suppress progress output on stderr")
		.option("--verbose", "show per-analyzer progress on stderr")
		.action(function (this: Command, repoPath: string) {
			return runAuditCommand(repoPath, this.optsWithGlobals() as AuditCliOptions);
		});
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
 * Resolve the core service options for this run. Without `--provider`
 * selections this is exactly the previous pass-through (`--config` or root
 * discovery, decided by the core). With them, the flag selections apply
 * **per provider** over the declarative configuration's `providers` block:
 * a provider named by a flag uses the flag's request, providers not named
 * keep their `trellis.yaml` entry. The base configuration is loaded through
 * the core loaders with the same precedence the service itself applies, so
 * an invalid `trellis.yaml` stays the same operational error it always was.
 */
async function resolveServiceOptions(
	repoPath: string,
	opts: AuditCliOptions,
	providerSelection: ProviderSelection | undefined,
): Promise<WorkspaceAuditOptions> {
	const common = {
		...(opts.baseline ? { baselinePath: opts.baseline } : {}),
		...(opts.history === true ? { history: true } : {}),
		...(opts.db ? { db: opts.db } : {}),
	};
	if (providerSelection === undefined) {
		return { ...common, ...(opts.config ? { configPath: opts.config } : {}) };
	}
	let base: AuditConfig;
	try {
		base = opts.config ? await loadAuditConfigFile(opts.config) : await loadAuditConfig(repoPath);
	} catch (error) {
		throw new CliError(error instanceof Error ? error.message : String(error));
	}
	return {
		...common,
		config: { ...base, providers: { ...base.providers, ...providerSelection } },
	};
}

/**
 * Call the core audit service, mapping every failure onto the operational
 * exit (SPEC §9): the audit could not run, nothing was emitted — exit 1 with
 * the reason. The progress line is always cleared on the way out.
 */
async function runService(
	repoPath: string,
	opts: AuditCliOptions,
	providerSelection: ProviderSelection | undefined,
	reporter: ReturnType<typeof createProgressReporter>,
): Promise<WorkspaceAuditResult> {
	try {
		const coreOptions = await resolveServiceOptions(repoPath, opts, providerSelection);
		return await runWorkspaceAudit(repoPath, {
			...coreOptions,
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
	// Translate --provider flags (and reject bad selections) before any
	// measurement work, so an invalid selection fails fast and stateless.
	const providerSelection =
		opts.provider === undefined || opts.provider.length === 0
			? undefined
			: providerSelectionFromFlags(opts.provider);
	// Validate the report target up front so a bad `--out` fails immediately,
	// before the measurement pass runs.
	if (opts.out !== undefined) assertWritableTarget(opts.out);
	const quiet = opts.quiet === true;
	const reporter = createProgressReporter({
		quiet,
		verbose: opts.verbose === true,
		isTTY: Boolean(process.stderr.isTTY),
	});
	const result = await runService(repoPath, opts, providerSelection, reporter);
	const rendered = {
		human: renderAuditTerminal(result.report),
		json: result.report,
		md: renderAuditMarkdown(result.report),
	} satisfies Rendered;
	// --out selects the file destination; otherwise emit the report to stdout.
	if (opts.out !== undefined) {
		writeReportFile(opts.out, formatForPath(opts.out, format), rendered);
		if (!quiet) process.stderr.write(`trellis: report written to ${opts.out}\n`);
	} else {
		emit(format, rendered);
	}
	if (result.policy.failed) throw new FailOnExit(policyReasonLines(result.policy));
}
