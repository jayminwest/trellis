/**
 * One dependency-cruiser provider analysis over a workspace selection (SPEC
 * §16.2–16.5, plan `pl-43c5` step 22 — trellis-adbf; the audit-side wiring
 * lives in `src/audit/providers.ts`).
 *
 * {@link runDependencyCruiserAnalysis} composes the delivered boundaries
 * unchanged into the contract's {@link AnalysisResult}: it stages an
 * isolated source view of the selection (`../workspace.ts` through the
 * `../staged-run.ts` lifecycle with guaranteed owned-scratch cleanup), runs
 * the pinned adapter (`./adapter.ts` — resolver, controlled process runner,
 * generated tool config, raw validation), normalizes the one cruise's
 * report over the staged snapshot (`./normalize.ts`), and folds the
 * outcome to typed evidence.
 *
 * Honesty rules the fold enforces (mirroring the jscpd fold,
 * `../jscpd/analysis.ts`):
 *
 * - **Per-run states.** The cruise outcome's state is carried as-is; no
 *   invented metrics — a never-ran analysis carries only its located
 *   reason. A zero-rule request is valid and runs: an absent rule set is
 *   recorded identity (rule count `0`), never a coherence claim.
 * - **Normalized evidence attaches only from the staged snapshot.** The
 *   accounted files are the staged copies (exactly the bytes the pinned
 *   tool consumed). Normalization failure degrades to `incomplete` with
 *   the located reason — provider evidence never aborts the audit.
 * - **Coverage honesty is the point.** An empty or partial graph is
 *   `incomplete` with its located reason and its observed coverage — never
 *   a clean pass with zero violations; builtins, externals and
 *   unresolved-local stubs stay separate evidence.
 * - **Cleanup is visible (§16.4).** A failed owned-scratch cleanup is never
 *   silently dropped: a `complete` result degrades to `incomplete` with the
 *   cleanup failure as its located reason, and any other state appends it.
 * - **Never a native result.** The result is always the external
 *   `dependency-cruiser` identity with namespaced, unscored evidence
 *   (§16.5); every failure keeps the native audit untouched.
 */
import type {
	AnalysisDiagnostic,
	AnalysisResult,
	DependencyCruiserProviderRequest,
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
import { type DependencyCruiserAdapterResult, runDependencyCruiserAdapter } from "./adapter.ts";
import type { DependencyCruiserOutcome } from "./cruise-run.ts";
import { neverRan } from "./invocation.ts";
import {
	type DependencyCruiserNormalizedEvidence,
	normalizeDependencyCruiserReport,
} from "./normalize.ts";
import { compileArchitecturePolicy } from "./policy.ts";

/** Options for {@link runDependencyCruiserAnalysis}. */
export interface DependencyCruiserAnalysisOptions {
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

/** Normalize one validated cruise outcome; throws only on invalid evidence. */
function normalizedEvidence(
	view: StagedWorkspaceView,
	request: DependencyCruiserProviderRequest,
	outcome: Extract<DependencyCruiserOutcome, { state: "complete" | "incomplete" }>,
): DependencyCruiserNormalizedEvidence {
	if (!("report" in outcome) || outcome.report === undefined) {
		throw new Error("the outcome carries no raw report to normalize");
	}
	const coverage =
		"coverage" in outcome && outcome.coverage !== undefined
			? outcome.coverage
			: { selectedFiles: 0, representedFiles: [], missingFiles: [], stubs: [], totalCruised: 0 };
	return normalizeDependencyCruiserReport(
		outcome.report,
		compileArchitecturePolicy(request),
		coverage,
		view.files.map((file) => file.path),
	);
}

/** The observed coverage of a cruise that asserted (part of) its selection. */
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

/** Fold one adapter result into the contract result over the staged view it ran on. */
async function foldOutcome(
	view: StagedWorkspaceView,
	request: DependencyCruiserProviderRequest,
	adapter: DependencyCruiserAdapterResult,
): Promise<AnalysisResult> {
	const outcome = adapter.outcome;
	if (outcome.state !== "complete" && outcome.state !== "incomplete") {
		// The cruise never ran (resolution, parser or version failure, exhausted
		// limits, an unsupported host): located evidence with the actionable
		// install instructions appended — never a fabricated clean result.
		const reason =
			"instructions" in outcome && outcome.instructions !== undefined
				? `${outcome.reason} — ${outcome.instructions}`
				: outcome.reason;
		return neverRan(compileArchitecturePolicy(request), outcome.state, reason);
	}
	if (outcome.state === "incomplete") {
		const base = {
			provider: outcome.provider,
			state: "incomplete" as const,
			analysis: outcome.analysis,
			reason: outcome.reason,
		};
		const analyzed = "coverage" in outcome ? (outcome.coverage?.representedFiles ?? []) : [];
		const diagnostics = [...stagingDiagnostics(view), { message: outcome.reason }];
		try {
			const normalized = normalizedEvidence(view, request, outcome);
			return {
				...base,
				observedCoverage: observedCoverage(view, analyzed, diagnostics),
				metrics: [...normalized.metrics],
				findings: [...normalized.findings],
			};
		} catch {
			return { ...base, observedCoverage: observedCoverage(view, analyzed, diagnostics) };
		}
	}
	// state === "complete": full observed coverage over exactly the staged
	// selection, plus the normalized namespaced evidence. A normalization
	// failure degrades to incomplete with the located reason — never a crash,
	// never a clean result.
	try {
		const normalized = normalizedEvidence(view, request, outcome);
		return {
			provider: outcome.provider,
			state: "complete",
			analysis: outcome.analysis,
			observedCoverage: {
				analyzedFiles: [...outcome.coverage.representedFiles],
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
			reason: `validated dependency-cruiser evidence failed to normalize over the staged snapshot: ${messageOf(error)}`,
			observedCoverage: {
				analyzedFiles: [...outcome.coverage.representedFiles],
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
 * Run the requested dependency-cruiser analysis over an isolated staged
 * view of `selection` (the audit's measured files) and return the contract
 * result (see the module docblock). The declarative request is compiled
 * and validated before anything runs — an invalid request is an
 * operational error (SPEC §16.3) — and never throws for execution
 * outcomes: every failure is located evidence; only operational staging
 * errors reject.
 */
export async function runDependencyCruiserAnalysis(
	root: string,
	selection: readonly StagedSelectionFile[],
	request: DependencyCruiserProviderRequest,
	options: DependencyCruiserAnalysisOptions = {},
): Promise<AnalysisResult> {
	const policy = compileArchitecturePolicy(request);
	if (selection.length === 0) {
		return neverRan(
			policy,
			"unsupported",
			"the measured selection is empty — architecture evidence requires at least one staged file to analyze",
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
			{ root, files: selection },
			async (view) =>
				await foldOutcome(
					view,
					request,
					await runDependencyCruiserAdapter(view, request, runRequest),
				),
			lifecycleOptions,
		);
	} catch (error) {
		const reason =
			error instanceof InvalidStagingRequestError || error instanceof StagingError
				? error.message
				: `staging failed unexpectedly: ${messageOf(error)}`;
		return neverRan(policy, "unavailable", reason);
	}
	switch (lifecycle.kind) {
		case "completed":
			return degradedForCleanup(lifecycle.value, lifecycle.cleanup);
		case "adapter-failed":
			return degradedForCleanup(
				neverRan(
					policy,
					"unavailable",
					`the dependency-cruiser adapter failed: ${messageOf(lifecycle.error)}`,
				),
				lifecycle.cleanup,
			);
		case "cancelled":
			return degradedForCleanup(
				neverRan(
					policy,
					"unavailable",
					"the audit was cancelled before the architecture analysis completed; the provider process group was terminated and no evidence was produced",
				),
				lifecycle.cleanup,
			);
		case "timeout":
			return degradedForCleanup(
				neverRan(policy, "unavailable", "the architecture analysis exceeded its wall-time limit"),
				lifecycle.cleanup,
			);
	}
}
