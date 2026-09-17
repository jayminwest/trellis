/**
 * One pinned jscpd mode run over a staged source view (SPEC §16.2–16.4,
 * plan `pl-43c5` — trellis-f4e2, step 12; called by `adapter.ts`).
 *
 * A mode run writes exactly two things, both inside the view's owned
 * scratch `work/` area — an empty pinned config file (blocking jscpd's
 * ancestor config discovery) and one report output directory — then
 * starts the resolved executable through the controlled process runner
 * (`../process.ts`) with the fixed argv from `./invocation.ts`, reads the
 * raw JSON report, and validates it with `./raw.ts`. It never touches the
 * target workspace, never scores, and never normalizes (step 13 owns
 * that); the validated raw report plus the honest per-mode state is the
 * product.
 *
 * **Coverage honesty (the mode's state):** jscpd's
 * `statistics.total.sources` counts only files at/above its token
 * threshold — files below it are omitted from the tool's own accounting,
 * so they are *not asserted analyzed*. The run records that as an explicit
 * coverage account (selected vs. reported vs. omitted) and stays
 * `incomplete` when any file is omitted, since per-file observed coverage
 * cannot be enumerated from the provider's evidence; only a fully
 * reconciled account (`sources === selected`, no staging gaps) is
 * `complete`, with the selection enumerable as analyzed files.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AnalysisIdentity, CloneMatchMode, ProviderIdentity } from "../../contract/index.ts";
import {
	type ControlledProcessOutcome,
	type ResolvedExecutable,
	runControlledProcess,
} from "../process.ts";
import { messageOf } from "../staging.ts";
import type { StagedWorkspaceView } from "../workspace.ts";
import {
	type JscpdThresholds,
	jscpdAnalysisIdentity,
	jscpdConfigPath,
	jscpdInvocationArgs,
	jscpdOutputDir,
	jscpdProviderIdentity,
} from "./invocation.ts";
import { parseRawJscpdReport, type RawJscpdReport, validateRawJscpdEvidence } from "./raw.ts";

/** The pinned file name jscpd's json reporter writes into the output directory. */
const JSCPD_REPORT_FILE_NAME = "jscpd-report.json";

/** Bound every echoed provider diagnostic (reasons are evidence, not firehoses). */
const MAX_EXCERPT_CHARS = 240;

/** How jscpd's own evidence accounts for the staged selection (never a coverage claim). */
export interface JscpdCoverageAccount {
	/** Staged files the adapter handed the tool (the analysis selection). */
	selectedFiles: number;
	/** Files jscpd's statistics credit as sources — only files at/above the token threshold. */
	reportedSources: number;
	/** `selectedFiles − reportedSources`: files the tool's statistics omit (below threshold or skipped). */
	omittedFromSourceStatistics: number;
	/** The enumerable analyzed files — present only when the account fully reconciles. */
	analyzedFiles?: readonly string[];
}

/** One mode's outcome; the states mirror the §16.2 provider states. */
export type JscpdModeOutcome =
	| {
			state: "complete";
			mode: CloneMatchMode;
			provider: ProviderIdentity;
			analysis: AnalysisIdentity;
			report: RawJscpdReport;
			coverage: JscpdCoverageAccount & { analyzedFiles: readonly string[] };
			exitCode: number;
	  }
	| {
			state: "incomplete";
			mode: CloneMatchMode;
			provider: ProviderIdentity;
			analysis: AnalysisIdentity;
			/** What could not be analyzed or asserted — located, bounded. */
			reason: string;
			/** Schema-valid raw evidence, attached when a report was parsed (never fabricated). */
			report?: RawJscpdReport;
			coverage?: JscpdCoverageAccount;
			exitCode?: number;
	  }
	| {
			state: "unavailable" | "unsupported";
			mode: CloneMatchMode;
			provider: ProviderIdentity;
			reason: string;
			/** Install instructions for resolution failures (actionable, from the manifest). */
			instructions?: string;
	  };

/** Bounded reason for any process outcome (§16.2: could not run). */
export function outcomeReason(outcome: ControlledProcessOutcome): string {
	if (outcome.kind === "exited") {
		return `the provider process exited with code ${outcome.exitCode}`;
	}
	if (outcome.kind === "signaled") {
		return `the provider process was terminated by signal ${outcome.signalCode}`;
	}
	return outcome.reason;
}

/** Collapse a provider diagnostic into one bounded reason fragment. */
function excerpt(text: string): string {
	const collapsed = text.replaceAll(/\s+/g, " ").trim();
	return collapsed.length > MAX_EXCERPT_CHARS
		? `${collapsed.slice(0, MAX_EXCERPT_CHARS)}…`
		: collapsed;
}

/** The coverage account for a validated report against the staged view. */
function coverageAccount(view: StagedWorkspaceView, report: RawJscpdReport): JscpdCoverageAccount {
	const selectedFiles = view.files.length;
	const reportedSources = report.statistics.total.sources;
	return {
		selectedFiles,
		reportedSources,
		omittedFromSourceStatistics: Math.max(0, selectedFiles - reportedSources),
	};
}

/** Why the staged view itself is not the full intended selection, or `undefined` when it is. */
function stagingGapReason(view: StagedWorkspaceView): string | undefined {
	const unreadable = view.readFailures.length;
	const refused = view.rejected.length;
	if (unreadable === 0 && refused === 0) {
		return undefined;
	}
	return `${unreadable} selected file(s) could not be read and ${refused} were refused staging — the staged view does not cover the full intended selection`;
}

/**
 * Run one pinned jscpd mode over the staged view and validate its raw
 * report. Every defined outcome is returned — the promise only rejects on
 * an invalid request (operational error, SPEC §16.3).
 */
export async function runJscpdMode(
	view: StagedWorkspaceView,
	executable: ResolvedExecutable,
	mode: CloneMatchMode,
	options: {
		thresholds: JscpdThresholds;
		limits: { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal };
	},
): Promise<JscpdModeOutcome> {
	const provider = jscpdProviderIdentity(mode, options.thresholds);
	const analysis = jscpdAnalysisIdentity(view, mode, options.thresholds);
	const unavailable = (reason: string): JscpdModeOutcome => ({
		state: "unavailable",
		mode,
		provider,
		reason,
	});

	const configPath = jscpdConfigPath(view);
	const outputDir = jscpdOutputDir(view, mode);
	try {
		await writeFile(configPath, "{}");
		await mkdir(outputDir, { recursive: true });
	} catch (error) {
		return unavailable(`owned scratch could not be prepared (${messageOf(error)})`);
	}

	const result = await runControlledProcess(executable, {
		args: jscpdInvocationArgs({
			stagedRoot: view.stagedRoot,
			configPath,
			outputDir,
			mode,
			thresholds: options.thresholds,
		}),
		cwd: view.scratchDir,
		env: {},
		timeoutMs: options.limits.timeoutMs,
		maxOutputBytes: options.limits.maxOutputBytes,
		signal: options.limits.signal,
	});
	if (result.outcome.kind !== "exited") {
		return unavailable(outcomeReason(result.outcome));
	}

	const exitCode = result.outcome.exitCode;
	if (exitCode !== 0) {
		const diagnostics = excerpt(result.stderr);
		return {
			state: "incomplete",
			mode,
			provider,
			analysis,
			reason:
				`jscpd exited with code ${exitCode}` +
				(diagnostics === "" ? " (no diagnostics)" : `: ${diagnostics}`),
			exitCode,
		};
	}

	const text = await readFile(join(outputDir, JSCPD_REPORT_FILE_NAME), "utf8").catch(
		() => undefined,
	);
	if (text === undefined) {
		return {
			state: "incomplete",
			mode,
			provider,
			analysis,
			reason: `jscpd exited 0 but wrote no readable JSON report (expected ${JSCPD_REPORT_FILE_NAME} in the owned output area)`,
			exitCode,
		};
	}
	const parsed = parseRawJscpdReport(text);
	if (!parsed.ok) {
		return {
			state: "incomplete",
			mode,
			provider,
			analysis,
			reason: `raw jscpd report failed validation: ${parsed.reasons.join("; ")}`,
			exitCode,
		};
	}
	const report = parsed.report;
	const coverage = coverageAccount(view, report);
	const selectionPaths = new Set(view.files.map((file) => file.path));
	const reasons = validateRawJscpdEvidence(report, selectionPaths, mode);
	if (reasons.length > 0) {
		return {
			state: "incomplete",
			mode,
			provider,
			analysis,
			reason: `raw jscpd report carries suspect evidence: ${reasons.join("; ")}`,
			report,
			coverage,
			exitCode,
		};
	}

	const gap = stagingGapReason(view);
	if (coverage.omittedFromSourceStatistics === 0 && gap === undefined) {
		return {
			state: "complete",
			mode,
			provider,
			analysis,
			report,
			coverage: { ...coverage, analyzedFiles: [...selectionPaths].sort() },
			exitCode,
		};
	}
	const parts: string[] = [];
	if (coverage.omittedFromSourceStatistics > 0) {
		parts.push(
			`${coverage.omittedFromSourceStatistics} of ${coverage.selectedFiles} staged files are omitted from ` +
				`jscpd's source statistics (below the ${options.thresholds.minTokens}-token threshold or skipped by ` +
				`the tool) — they are not asserted analyzed, so per-file observed coverage cannot be enumerated`,
		);
	}
	if (gap !== undefined) {
		parts.push(gap);
	}
	return {
		state: "incomplete",
		mode,
		provider,
		analysis,
		reason: parts.join("; "),
		report,
		coverage:
			coverage.omittedFromSourceStatistics === 0
				? { ...coverage, analyzedFiles: [...selectionPaths].sort() }
				: coverage,
		exitCode,
	};
}
