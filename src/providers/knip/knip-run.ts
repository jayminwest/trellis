/**
 * One pinned Knip reachability pass over a staged source view (SPEC
 * §16.2–16.4, plan `pl-43c5` step 24 — trellis-8ebc; called by
 * `./adapter.ts`).
 *
 * The pass writes exactly three trellis-owned files — the **generated**
 * tool configuration and the generated minimal tsconfig into the staged
 * view's scratch `work/` area (`./tool-config.ts`, blocking the tool's
 * ancestor-config discovery; never a target `knip` configuration), and the
 * generated minimal workspace manifest Knip requires into the staged source
 * tree (trellis-owned scratch — the staged tree is a frozen copy, never the
 * target workspace) — then starts the pinned launcher through the
 * controlled process runner (`../process.ts`) from the staged root.
 *
 * **Exit-code protocol (coverage honesty — the research record's silent
 * failures, made visible):** the findings exit code is neutralized
 * (`--max-issues` above any real candidate count) and configuration hints
 * are promoted to errors, so the exit status carries exactly one meaning.
 * Exit `0` — every submitted entry/project pattern matched the staged scope
 * and the tool completed its analysis. Exit `1` — the tool reported a
 * configuration hint: a submitted pattern matched nothing, an **empty or
 * partial analysis**, located as `incomplete` with the schema-valid report
 * still attached, never a clean pass. Exit `2` — the tool could not run its
 * analysis (invalid generated configuration, unreadable inputs):
 * `incomplete` with the bounded stderr. Non-exit outcomes (timeout, output
 * overflow, cancellation, signals) are `unavailable`. Zero candidates over
 * a coherent scope is a legitimate clean zero — candidates are contextual
 * evidence, and zero findings never proves overall quality.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AnalysisIdentity, ProviderIdentity } from "../../contract/index.ts";
import {
	type ControlledProcessOutcome,
	type ResolvedExecutable,
	runControlledProcess,
} from "../process.ts";
import { messageOf } from "../staging.ts";
import type { StagedWorkspaceView } from "../workspace.ts";
import type { PreparedReachabilityContext } from "./context.ts";
import { knipAnalysisIdentity, knipEnvironment, knipProviderIdentity } from "./invocation.ts";
import { parseRawKnipReport, type RawKnipReport, validateRawKnipEvidence } from "./raw.ts";
import {
	knipInvocationArgs,
	knipToolConfig,
	knipTsConfig,
	knipWorkspaceManifest,
} from "./tool-config.ts";

/** Bounded reasons, and bounded missing-file lists: diagnostics are evidence, not firehoses. */
const MAX_EXCERPT_CHARS = 240;
const MAX_NAMED_SCOPE_GAPS = 5;

/** How the pass's own evidence accounts for its submitted scope (never a coverage claim). */
export interface ReachabilityCoverage {
	/** The submitted analysis scope: the context's roots plus project files, sorted. */
	scopeFiles: readonly string[];
	/** Scope files the staged view could not stage — the coverage loss, sorted. */
	missingScopeFiles: readonly string[];
	/** Files carrying candidate records in the validated report, sorted (observable evidence). */
	candidateFiles: readonly string[];
	/** The tool's reported row count, retained for explanation only. */
	issueRows: number;
}

/** One pass's outcome; the states mirror the §16.2 provider states. */
export type KnipOutcome =
	| {
			state: "complete";
			provider: ProviderIdentity;
			analysis: AnalysisIdentity;
			report: RawKnipReport;
			coverage: ReachabilityCoverage;
			exitCode: number;
	  }
	| {
			state: "incomplete";
			provider: ProviderIdentity;
			analysis: AnalysisIdentity;
			/** What could not be analyzed or asserted — located, bounded. */
			reason: string;
			/** Schema-valid raw evidence, attached when a report was parsed (never fabricated). */
			report?: RawKnipReport;
			coverage?: ReachabilityCoverage;
			exitCode?: number;
	  }
	| {
			state: "unavailable" | "unsupported";
			provider: ProviderIdentity;
			reason: string;
			/** Install instructions for resolution failures (actionable, from the manifest). */
			instructions?: string;
	  };

/** Bounded reason for any process outcome (§16.2: could not run). */
export function knipOutcomeReason(outcome: ControlledProcessOutcome): string {
	switch (outcome.kind) {
		case "exited":
			return `the provider process exited with code ${outcome.exitCode}`;
		case "signaled":
			return `the provider process was terminated by signal ${outcome.signalCode}`;
		default:
			return outcome.reason;
	}
}

/** Collapse a provider diagnostic into one bounded reason fragment. */
function excerpt(text: string): string {
	const collapsed = text.replaceAll(/\s+/g, " ").trim();
	return collapsed.length > MAX_EXCERPT_CHARS
		? `${collapsed.slice(0, MAX_EXCERPT_CHARS)}…`
		: collapsed;
}

/** The coverage account of the pass: submitted scope, staging gaps, observed candidate files. */
export function reachabilityCoverage(
	view: StagedWorkspaceView,
	context: PreparedReachabilityContext,
	report: RawKnipReport | undefined,
): ReachabilityCoverage {
	const staged = new Set(view.files.map((file) => file.path));
	const scope = [
		...new Set([...context.entryRoots, ...context.testRoots, ...context.projectFiles]),
	].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	return {
		scopeFiles: scope,
		missingScopeFiles: scope.filter((path) => !staged.has(path)),
		candidateFiles:
			report === undefined
				? []
				: report.issues.map((row) => row.file).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
		issueRows: report?.issues.length ?? 0,
	};
}

/** The located reason a staging gap carries — the submitted scope the tool never saw. */
export function scopeGapReason(coverage: ReachabilityCoverage): string | undefined {
	if (coverage.missingScopeFiles.length === 0) return undefined;
	const named = coverage.missingScopeFiles
		.slice(0, MAX_NAMED_SCOPE_GAPS)
		.map((path) => `"${path}"`);
	const further = coverage.missingScopeFiles.length - named.length;
	const suffix = further > 0 ? `, …and ${further} more` : "";
	return (
		`${coverage.missingScopeFiles.length} submitted scope file(s) could not be staged ` +
		`(${named.join(", ")}${suffix}) — the pass ran over an incomplete copy of the declared ` +
		"reachability scope"
	);
}

/** Prepare the owned scratch one pass runs from: generated config, tsconfig and workspace manifest. */
async function prepareOwnedScratch(
	view: StagedWorkspaceView,
	context: PreparedReachabilityContext,
	pluginNames: readonly string[],
): Promise<{ configPath: string; tsConfigPath: string } | { unavailable: string }> {
	const manifestPath = join(view.stagedRoot, "package.json");
	if (existsSync(manifestPath)) {
		return {
			unavailable:
				"the staged source view unexpectedly carries a package manifest — the source-only staging " +
				"invariant is broken, so a target manifest could reach the analysis",
		};
	}
	const configPath = join(view.workDir, "knip.json");
	const tsConfigPath = join(view.workDir, "tsconfig.json");
	try {
		await mkdir(view.workDir, { recursive: true });
		await writeFile(
			configPath,
			`${JSON.stringify(knipToolConfig(context, pluginNames), undefined, 2)}\n`,
		);
		await writeFile(tsConfigPath, knipTsConfig());
		await writeFile(manifestPath, knipWorkspaceManifest());
	} catch (error) {
		return { unavailable: `owned scratch could not be prepared (${messageOf(error)})` };
	}
	return { configPath, tsConfigPath };
}

/** Fold one completed provider process into a pass outcome (see the module docblock). */
function decodePassOutcome(
	result: {
		outcome: Extract<ControlledProcessOutcome, { kind: "exited" }>;
		stdout: string;
		stderr: string;
	},
	view: StagedWorkspaceView,
	context: PreparedReachabilityContext,
	identities: { provider: ProviderIdentity; analysis: AnalysisIdentity },
): KnipOutcome {
	const { provider, analysis } = identities;
	const exitCode = result.outcome.exitCode;
	const parsed = parseRawKnipReport(result.stdout);
	if (exitCode === 2) {
		const diagnostics = excerpt(result.stderr);
		return {
			state: "incomplete",
			provider,
			analysis,
			reason:
				`knip could not run its analysis (exit code 2)` +
				(diagnostics === "" ? " (no diagnostics)" : `: ${diagnostics}`),
			exitCode,
		};
	}
	if (!parsed.ok) {
		return {
			state: "incomplete",
			provider,
			analysis,
			reason: `raw knip report failed validation: ${parsed.reasons.join("; ")}`,
			exitCode,
		};
	}
	const report = parsed.report;
	const stagedPaths = new Set(view.files.map((file) => file.path));
	const suspect = validateRawKnipEvidence(report, stagedPaths);
	const coverage = reachabilityCoverage(view, context, report);
	const gap = scopeGapReason(coverage);
	const hintReason =
		"knip reported configuration hints — a submitted entry/project pattern matched no staged " +
		"file (the JSON report carries no hint detail); the pass is an empty or partial analysis of " +
		"the declared scope, never a clean pass";
	const parts: string[] = [];
	if (exitCode === 1) parts.push(hintReason);
	if (gap !== undefined) parts.push(gap);
	if (suspect.length > 0)
		parts.push(`the raw report carries suspect evidence: ${suspect.join("; ")}`);
	if (parts.length === 0) {
		return { state: "complete", provider, analysis, report, coverage, exitCode };
	}
	return {
		state: "incomplete",
		provider,
		analysis,
		reason: parts.join("; "),
		report,
		coverage,
		exitCode,
	};
}

/** Run one pinned knip pass over the staged view (see the module docblock). */
export async function runKnipReachabilityPass(
	view: StagedWorkspaceView,
	context: PreparedReachabilityContext,
	invocation: { interpreter: ResolvedExecutable; launcher: ResolvedExecutable },
	pluginNames: readonly string[],
	parserVersion: string,
	limits: { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal },
): Promise<KnipOutcome> {
	const provider = knipProviderIdentity(context);
	const analysis = knipAnalysisIdentity(view, context, parserVersion);
	if (analysis === undefined) {
		return {
			state: "unavailable",
			provider,
			reason:
				"the staged scope is empty — reachability evidence requires at least one staged file to analyze",
		};
	}
	const unavailable = (reason: string): KnipOutcome => ({ state: "unavailable", provider, reason });

	const scratch = await prepareOwnedScratch(view, context, pluginNames);
	if ("unavailable" in scratch) return unavailable(scratch.unavailable);

	const result = await runControlledProcess(invocation.interpreter, {
		args: [
			invocation.launcher.path,
			...knipInvocationArgs({
				directory: view.stagedRoot,
				configPath: scratch.configPath,
				tsConfigPath: scratch.tsConfigPath,
			}),
		],
		cwd: view.stagedRoot,
		env: knipEnvironment(view.workDir),
		timeoutMs: limits.timeoutMs,
		maxOutputBytes: limits.maxOutputBytes,
		signal: limits.signal,
	});
	if (result.outcome.kind !== "exited") {
		return unavailable(knipOutcomeReason(result.outcome));
	}
	return decodePassOutcome(
		{ outcome: result.outcome, stdout: result.stdout, stderr: result.stderr },
		view,
		context,
		{ provider, analysis },
	);
}
