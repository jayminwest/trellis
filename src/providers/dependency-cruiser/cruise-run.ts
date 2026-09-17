/**
 * One pinned dependency-cruiser cruise over a staged source view (SPEC
 * §16.2–16.4, plan `pl-43c5` step 22 — trellis-adbf; called by
 * `./adapter.ts`).
 *
 * A cruise writes exactly two trellis-owned files into the staged view's
 * scratch `work/` area — the **generated** tool configuration
 * (`./tool-config.ts`, blocking the tool's ancestor-config discovery;
 * never a target `.dependency-cruiser` file) and the generated minimal
 * tsconfig — then starts the pinned launcher through the controlled
 * process runner (`../process.ts`) from the staged root, so reported
 * module sources are the selection's repo-relative paths and the declared
 * selectors match them. It never touches the target workspace, never
 * scores, never normalizes (`./normalize.ts` owns that); the validated raw
 * report plus the honest coverage account is the product.
 *
 * **Coverage honesty (the run's state — the research record's central
 * failure):** a successful exit with an **empty or partial graph** is
 * `incomplete` with located reasons, never a clean pass — a missing or
 * unsupported TypeScript parser, an unresolvable tsconfig or an excluded
 * module set all produce a successful empty graph. Only a report whose
 * module set asserts **every** staged selection file (with no staging
 * gaps and no suspect evidence) is `complete`, with the selection
 * enumerable as analyzed files. Builtins, externals and unresolved-local
 * stub nodes are preserved separately from production nodes — counted
 * and named, never folded into coverage.
 */
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
import {
	dependencyCruiserAnalysisIdentity,
	dependencyCruiserEnvironment,
	dependencyCruiserProviderIdentity,
} from "./invocation.ts";
import type { CompiledArchitecturePolicy } from "./policy.ts";
import {
	parseRawDependencyCruiserReport,
	type RawDependencyCruiserReport,
	validateRawDependencyCruiserEvidence,
} from "./raw.ts";
import {
	dependencyCruiserInvocationArgs,
	dependencyCruiserToolConfig,
	dependencyCruiserTsConfig,
	generatedRuleNames,
} from "./tool-config.ts";

/** Bounded reasons, and bounded missing-file lists: diagnostics are evidence, not firehoses. */
const MAX_EXCERPT_CHARS = 240;
const MAX_NAMED_MISSING_FILES = 5;

/** One classified non-production node the tool reported (preserved separately from production nodes). */
export interface CruiseStub {
	/** The node as the tool names it (`zod`, `fs`, `./missing.ts`). */
	source: string;
	kind: "builtin" | "external" | "unresolved-local";
}

/** How the cruise's own evidence accounts for the staged selection (never a coverage claim). */
export interface CruiseCoverage {
	/** Staged files the cruise handed the tool (the analysis selection). */
	selectedFiles: number;
	/** Selection files the reported modules assert, sorted. */
	representedFiles: readonly string[];
	/** Selection files missing from the reported modules — the coverage loss, sorted. */
	missingFiles: readonly string[];
	/** Non-production nodes, sorted by source then kind (builtins, externals, unresolved locals). */
	stubs: readonly CruiseStub[];
	/** The tool's own total-cruised count, retained for explanation only. */
	totalCruised: number;
}

/** One cruise's outcome; the states mirror the §16.2 provider states. */
export type DependencyCruiserOutcome =
	| {
			state: "complete";
			provider: ProviderIdentity;
			analysis: AnalysisIdentity;
			report: RawDependencyCruiserReport;
			coverage: CruiseCoverage;
			exitCode: number;
	  }
	| {
			state: "incomplete";
			provider: ProviderIdentity;
			analysis: AnalysisIdentity;
			/** What could not be analyzed or asserted — located, bounded. */
			reason: string;
			/** Schema-valid raw evidence, attached when a report was parsed (never fabricated). */
			report?: RawDependencyCruiserReport;
			coverage?: CruiseCoverage;
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
export function cruiseOutcomeReason(outcome: ControlledProcessOutcome): string {
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

/** Classify one non-selection module node by its own reported fields (never a guess from the name alone). */
function classifyStub(
	source: string,
	module: RawDependencyCruiserReport["modules"][number],
): CruiseStub["kind"] {
	if (module.coreModule === true) return "builtin";
	if (module.couldNotResolve === true && /^(\.{1,2}\/|\/|#)/.test(source)) {
		return "unresolved-local";
	}
	return "external";
}

/** The coverage account of a parsed report against the staged selection. */
export function cruiseCoverage(
	view: StagedWorkspaceView,
	report: RawDependencyCruiserReport,
): CruiseCoverage {
	const selection = new Set(view.files.map((file) => file.path));
	const represented: string[] = [];
	const stubs: CruiseStub[] = [];
	for (const module of report.modules) {
		if (selection.has(module.source)) {
			represented.push(module.source);
			continue;
		}
		stubs.push({ source: module.source, kind: classifyStub(module.source, module) });
	}
	const representedSet = new Set(represented);
	return {
		selectedFiles: selection.size,
		representedFiles: represented.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
		missingFiles: view.files
			.map((file) => file.path)
			.filter((path) => !representedSet.has(path))
			.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
		stubs: stubs.sort((a, b) =>
			a.source < b.source ? -1 : a.source > b.source ? 1 : a.kind < b.kind ? -1 : 1,
		),
		totalCruised: report.summary.totalCruised,
	};
}

/** Why the staged view itself is not the full intended selection, or `undefined` when it is. */
function stagingGapReason(view: StagedWorkspaceView): string | undefined {
	const unreadable = view.readFailures.length;
	const refused = view.rejected.length;
	if (unreadable === 0 && refused === 0) return undefined;
	return `${unreadable} selected file(s) could not be read and ${refused} were refused staging — the staged view does not cover the full intended selection`;
}

/** The located reason an empty or partial graph carries — the research record's silent failure, made visible. */
export function missingFilesReason(coverage: CruiseCoverage): string {
	const named = coverage.missingFiles.slice(0, MAX_NAMED_MISSING_FILES).map((path) => `"${path}"`);
	const further = coverage.missingFiles.length - named.length;
	const suffix = further > 0 ? `, …and ${further} more` : "";
	return (
		`the reported graph does not assert ${coverage.missingFiles.length} of ` +
		`${coverage.selectedFiles} staged files (${named.join(", ")}${suffix}) — a missing or unsupported ` +
		`TypeScript parser, an unresolvable tsconfig or an excluded module set produces a successful empty ` +
		`graph, so these files are not asserted analyzed`
	);
}

/**
 * Run one pinned dependency-cruiser cruise over the staged view and
 * validate its raw report (see the module docblock). Every defined outcome
 * is returned — the promise only rejects on an invalid request
 * (operational error, SPEC §16.3).
 */
export async function runDependencyCruiserCruise(
	view: StagedWorkspaceView,
	policy: CompiledArchitecturePolicy,
	invocation: { interpreter: ResolvedExecutable; launcher: ResolvedExecutable },
	parserVersion: string,
	limits: { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal },
): Promise<DependencyCruiserOutcome> {
	const provider = dependencyCruiserProviderIdentity(policy);
	const analysis = dependencyCruiserAnalysisIdentity(view, policy, parserVersion);
	if (analysis === undefined) {
		return {
			state: "unavailable",
			provider,
			reason:
				"the staged selection is empty — architecture evidence requires at least one staged file to analyze",
		};
	}
	const unavailable = (reason: string): DependencyCruiserOutcome => ({
		state: "unavailable",
		provider,
		reason,
	});

	const configPath = join(view.workDir, "dependency-cruiser.json");
	const tsConfigPath = join(view.workDir, "tsconfig.json");
	try {
		await mkdir(view.workDir, { recursive: true });
		await writeFile(
			configPath,
			`${JSON.stringify(dependencyCruiserToolConfig(policy, { tsConfigPath }), undefined, 2)}\n`,
		);
		await writeFile(tsConfigPath, dependencyCruiserTsConfig());
	} catch (error) {
		return unavailable(`owned scratch could not be prepared (${messageOf(error)})`);
	}

	const result = await runControlledProcess(invocation.interpreter, {
		args: [invocation.launcher.path, ...dependencyCruiserInvocationArgs(configPath)],
		cwd: view.stagedRoot,
		env: dependencyCruiserEnvironment(view.workDir),
		timeoutMs: limits.timeoutMs,
		maxOutputBytes: limits.maxOutputBytes,
		signal: limits.signal,
	});
	if (result.outcome.kind !== "exited") {
		return unavailable(cruiseOutcomeReason(result.outcome));
	}
	const exitCode = result.outcome.exitCode;
	if (exitCode !== 0) {
		const diagnostics = excerpt(result.stderr);
		return {
			state: "incomplete",
			provider,
			analysis,
			reason:
				`dependency-cruiser exited with code ${exitCode}` +
				(diagnostics === "" ? " (no diagnostics)" : `: ${diagnostics}`),
			exitCode,
		};
	}

	const parsed = parseRawDependencyCruiserReport(result.stdout);
	if (!parsed.ok) {
		return {
			state: "incomplete",
			provider,
			analysis,
			reason: `raw dependency-cruiser report failed validation: ${parsed.reasons.join("; ")}`,
			exitCode,
		};
	}
	const report = parsed.report;
	const coverage = cruiseCoverage(view, report);
	const selectionPaths = new Set(view.files.map((file) => file.path));
	const suspect = validateRawDependencyCruiserEvidence(
		report,
		selectionPaths,
		generatedRuleNames(policy),
	);
	const gap = stagingGapReason(view);
	if (suspect.length === 0 && coverage.missingFiles.length === 0 && gap === undefined) {
		return { state: "complete", provider, analysis, report, coverage, exitCode };
	}
	const parts: string[] = [];
	if (coverage.missingFiles.length > 0) parts.push(missingFilesReason(coverage));
	if (suspect.length > 0)
		parts.push(`the raw report carries suspect evidence: ${suspect.join("; ")}`);
	if (gap !== undefined) parts.push(gap);
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
