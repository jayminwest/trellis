/**
 * One knip provider analysis over a workspace selection (SPEC §16.2–16.5,
 * plan `pl-43c5` step 24 — trellis-8ebc; the audit-side wiring lives in
 * `src/audit/providers.ts`).
 *
 * {@link runKnipAnalysis} composes the delivered boundaries unchanged into
 * the contract's {@link AnalysisResult}: it compiles the declarative
 * request (step 23's `./policy.ts`) and prepares the reachability context
 * over the **audit's measured selection** — before any staging, so the
 * recorded roots and contextual assumptions describe the audited selection,
 * never a staged subset — then stages an isolated source-only view of
 * exactly the context's scope (the roots plus the production project files;
 * non-participating test files are outside the analysis: they supply no
 * evidence and never dilute production denominators, AC2), runs the pinned
 * adapter (`./adapter.ts` — resolver, controlled process runner, generated
 * configuration, raw validation), normalizes the one pass's report over the
 * staged snapshot (`./normalize.ts`), and folds the outcome to typed
 * evidence.
 *
 * Honesty rules the fold enforces (mirroring the jscpd/dependency-cruiser
 * folds):
 *
 * - **Per-run states.** The pass outcome's state is carried as-is; no
 *   invented metrics — a never-ran analysis carries only its located
 *   reason.
 * - **Normalized evidence attaches only from the staged snapshot.** The
 *   accounted files are the staged copies (exactly the bytes the pinned
 *   tool consumed). Normalization failure degrades to `incomplete` with
 *   the located reason — provider evidence never aborts the audit.
 * - **Coverage honesty is the point.** An empty or partial pass
 *   (`incomplete`) carries its located reason and the observed scope; only
 *   a validated report over a fully staged, pattern-coherent scope is
 *   `complete`. A zero-candidate report over a coherent scope is a clean
 *   zero — and zero findings never proves overall quality.
 * - **Cleanup is visible (§16.4).** A failed owned-scratch cleanup degrades
 *   a `complete` result to `incomplete` with the failure as its located
 *   reason, and appends to any other state.
 * - **Never a native result.** The result is always the external `knip`
 *   identity with namespaced, unscored evidence (§16.5); every failure
 *   keeps the native audit untouched.
 */
import type {
	AnalysisDiagnostic,
	AnalysisResult,
	KnipProviderRequest,
	ObservedCoverage,
	SourceSet,
} from "../../contract/index.ts";
import type { PinnedToolResolveOptions } from "../resolve.ts";
import { type StagedRunOutcome, withStagedWorkspaceView } from "../staged-run.ts";
import {
	type CleanupStatus,
	InvalidStagingRequestError,
	messageOf,
	type StagedSelectionFile,
	StagingError,
} from "../staging.ts";
import type { StagedWorkspaceView } from "../workspace.ts";
import { type KnipAdapterResult, runKnipAdapter } from "./adapter.ts";
import { type PreparedReachabilityContext, prepareReachabilityContext } from "./context.ts";
import { knipNeverRan } from "./invocation.ts";
import type { KnipOutcome } from "./knip-run.ts";
import { type KnipNormalizedEvidence, normalizeKnipReport } from "./normalize.ts";
import { compileReachabilityPolicy } from "./policy.ts";

/** Options for {@link runKnipAnalysis}. */
export interface KnipAnalysisOptions {
	/** Cancellation handle, propagated to staging, the adapter and the provider process. */
	signal?: AbortSignal;
	/** Pinned-tool resolution options — the documented test seam for located resolution failures. */
	resolve?: PinnedToolResolveOptions;
	/** Wall-time limit for waiting on the staged analysis (the lifecycle's own bound). */
	timeoutMs?: number;
}

/** Per-source-set counts of the staged selection (the sets the analysis selected). */
function stagedBySourceSet(view: StagedWorkspaceView): Partial<Record<SourceSet, number>> {
	const bySourceSet: Partial<Record<SourceSet, number>> = {};
	for (const file of view.files) {
		bySourceSet[file.sourceSet] = (bySourceSet[file.sourceSet] ?? 0) + 1;
	}
	return bySourceSet;
}

/** Staging-level gaps as diagnostics: files the view could not read or refused to stage. */
function stagingDiagnostics(view: StagedWorkspaceView): AnalysisDiagnostic[] {
	return [
		...view.readFailures.map((failure) => ({ path: failure.path, message: failure.reason })),
		...view.rejected.map((rejection) => ({ path: rejection.path, message: rejection.reason })),
	];
}

/** Normalize one validated pass outcome; throws only on invalid evidence. */
function normalizedEvidence(
	outcome: Extract<KnipOutcome, { state: "complete" | "incomplete" }>,
	context: PreparedReachabilityContext,
): KnipNormalizedEvidence {
	if (!("report" in outcome) || outcome.report === undefined) {
		throw new Error("the outcome carries no raw report to normalize");
	}
	return normalizeKnipReport(outcome.report, context);
}

/** The observed coverage of a pass that asserted (part of) its selection. */
function observedCoverage(
	view: StagedWorkspaceView,
	analyzedFiles: readonly string[],
	diagnostics: AnalysisDiagnostic[],
): ObservedCoverage {
	return {
		analyzedFiles: [...analyzedFiles].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
		bySourceSet: stagedBySourceSet(view),
		diagnostics,
		unsupported: [],
	};
}

/** The analysis selection the context's scope resolves to: the measured files the scope names. */
function scopeSelection(
	context: PreparedReachabilityContext,
	selection: readonly StagedSelectionFile[],
): StagedSelectionFile[] {
	const scope = new Set([...context.entryRoots, ...context.testRoots, ...context.projectFiles]);
	return selection.filter((file) => scope.has(file.path));
}

/** Fold one adapter result into the contract result over the staged view it ran on. */
async function foldOutcome(
	view: StagedWorkspaceView,
	context: PreparedReachabilityContext,
	adapter: KnipAdapterResult,
): Promise<AnalysisResult> {
	const outcome = adapter.outcome;
	if (outcome.state !== "complete" && outcome.state !== "incomplete") {
		// The pass never ran (resolution, parser, registry or version failure,
		// exhausted limits, an unsupported host): located evidence with the
		// actionable install instructions appended — never a fabricated clean result.
		const reason =
			"instructions" in outcome && outcome.instructions !== undefined
				? `${outcome.reason} — ${outcome.instructions}`
				: outcome.reason;
		return knipNeverRan(context, outcome.state, reason);
	}
	if (outcome.state === "incomplete") {
		const base = {
			provider: outcome.provider,
			state: "incomplete" as const,
			analysis: outcome.analysis,
			reason: outcome.reason,
		};
		const diagnostics = [...stagingDiagnostics(view), { message: outcome.reason }];
		try {
			const normalized = normalizedEvidence(outcome, context);
			return {
				...base,
				observedCoverage: observedCoverage(view, [], diagnostics),
				metrics: [...normalized.metrics],
				findings: [...normalized.findings],
			};
		} catch {
			return { ...base, observedCoverage: observedCoverage(view, [], diagnostics) };
		}
	}
	// state === "complete": full observed coverage over exactly the staged
	// selection, plus the normalized namespaced evidence. A normalization
	// failure degrades to incomplete with the located reason — never a crash,
	// never a clean result.
	try {
		const normalized = normalizedEvidence(outcome, context);
		return {
			provider: outcome.provider,
			state: "complete",
			analysis: outcome.analysis,
			observedCoverage: {
				analyzedFiles: view.files.map((file) => file.path),
				bySourceSet: stagedBySourceSet(view),
				diagnostics: [],
				unsupported: [],
			},
			metrics: [...normalized.metrics],
			findings: [...normalized.findings],
		};
	} catch (error) {
		return {
			provider: outcome.provider,
			state: "incomplete",
			analysis: outcome.analysis,
			reason: `validated knip evidence failed to normalize over the staged snapshot: ${messageOf(error)}`,
			observedCoverage: {
				analyzedFiles: [],
				bySourceSet: stagedBySourceSet(view),
				diagnostics: [{ message: messageOf(error) }],
				unsupported: [],
			},
		};
	}
}

/** Make a failed owned-scratch cleanup visible (§16.4) — never a silently dropped condition. */
function degradedForCleanup(result: AnalysisResult, cleanup: CleanupStatus): AnalysisResult {
	if (cleanup.status !== "failed") return result;
	const note = `owned scratch cleanup failed: ${cleanup.reason}`;
	const coverage = result.observedCoverage;
	if (result.state === "complete" && coverage !== undefined) {
		return {
			...result,
			state: "incomplete",
			reason: note,
			observedCoverage: {
				...coverage,
				diagnostics: [...coverage.diagnostics, { message: note }],
			},
		};
	}
	return {
		...result,
		reason: result.reason === undefined ? note : `${result.reason}; ${note}`,
	};
}

/**
 * Run the requested knip reachability analysis over an isolated staged view
 * of the context's scope and return the contract result (see the module
 * docblock). The declarative request is compiled and the context prepared
 * before anything runs — an invalid request is an operational error (SPEC
 * §16.3) — and never throws for execution outcomes: every failure is
 * located evidence; only operational staging errors reject.
 */
export async function runKnipAnalysis(
	root: string,
	selection: readonly StagedSelectionFile[],
	request: KnipProviderRequest,
	options: KnipAnalysisOptions = {},
): Promise<AnalysisResult> {
	const policy = compileReachabilityPolicy(request);
	const context = prepareReachabilityContext(policy, selection);
	if (context.projectFiles.length === 0) {
		return knipNeverRan(
			context,
			"unsupported",
			"the measured selection contains no production files — reachability evidence requires " +
				"at least one production file to scope candidates over",
		);
	}
	const runRequest = {
		...(options.signal === undefined ? {} : { signal: options.signal }),
		...(options.resolve === undefined ? {} : { resolve: options.resolve }),
	};
	const lifecycleOptions = {
		...(options.signal === undefined ? {} : { signal: options.signal }),
		...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
	};
	let lifecycle: StagedRunOutcome<AnalysisResult>;
	try {
		lifecycle = await withStagedWorkspaceView(
			{ root, files: scopeSelection(context, selection) },
			async (view) =>
				await foldOutcome(view, context, await runKnipAdapter(view, context, runRequest)),
			lifecycleOptions,
		);
	} catch (error) {
		const reason =
			error instanceof InvalidStagingRequestError || error instanceof StagingError
				? error.message
				: `staging failed unexpectedly: ${messageOf(error)}`;
		return knipNeverRan(context, "unavailable", reason);
	}
	switch (lifecycle.kind) {
		case "completed":
			return degradedForCleanup(lifecycle.value, lifecycle.cleanup);
		case "adapter-failed":
			return degradedForCleanup(
				knipNeverRan(
					context,
					"unavailable",
					`the knip adapter failed: ${messageOf(lifecycle.error)}`,
				),
				lifecycle.cleanup,
			);
		case "cancelled":
			return degradedForCleanup(
				knipNeverRan(
					context,
					"unavailable",
					"the audit was cancelled before the reachability analysis completed; the provider " +
						"process group was terminated and no evidence was produced",
				),
				lifecycle.cleanup,
			);
		case "timeout":
			return degradedForCleanup(
				knipNeverRan(
					context,
					"unavailable",
					"the reachability analysis exceeded its wall-time limit",
				),
				lifecycle.cleanup,
			);
	}
}
