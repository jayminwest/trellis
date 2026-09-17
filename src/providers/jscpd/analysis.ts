/**
 * One jscpd provider analysis over a workspace selection (SPEC §16.2–16.5,
 * plan `pl-43c5` step 15 — trellis-15e3; the audit-side wiring lives in
 * `src/audit/providers.ts`).
 *
 * {@link runJscpdAnalysis} composes the delivered boundaries unchanged into
 * the contract's {@link AnalysisResult}: it stages an isolated source view of
 * the selection (`../workspace.ts` through the `../staged-run.ts` lifecycle
 * with guaranteed owned-scratch cleanup), runs the pinned adapter
 * (`./adapter.ts` — resolver, controlled process runner, fixed argv, raw
 * validation), normalizes the one requested mode's report over the staged
 * snapshot (`./normalize.ts`), and folds the outcome to typed evidence.
 *
 * Honesty rules the fold enforces:
 *
 * - **Per-run states.** The mode outcome's state is carried as-is
 *   (`complete`/`incomplete`/`unavailable`/`unsupported`); no invented
 *   metrics — a never-ran analysis carries only its located reason.
 * - **Normalized evidence attaches only from the staged snapshot.** The
 *   accounted files are the staged copies (exactly the bytes the pinned tool
 *   consumed), so line accounting can never describe content the tool did
 *   not analyze. Normalization failure degrades to `incomplete` with the
 *   reason — provider evidence never aborts the audit.
 * - **Cleanup is visible (§16.4).** A failed owned-scratch cleanup is never
 *   silently dropped: a `complete` result degrades to `incomplete` with the
 *   cleanup failure as its located reason (a cleanup failure is never a
 *   clean result), and any other state appends it to its reason.
 * - **Never a native result.** The result is always the external `jscpd`
 *   identity with namespaced, unscored evidence (§16.5); every failure keeps
 *   the native audit untouched.
 */
import { readFile } from "node:fs/promises";
import type {
	AnalysisDiagnostic,
	AnalysisResult,
	CloneMatchMode,
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
import { type JscpdAdapterResult, runJscpdAdapter } from "./adapter.ts";
import { JSCPD_DEFAULT_THRESHOLDS, jscpdProviderIdentity } from "./invocation.ts";
import type { JscpdAccountedFile } from "./lines.ts";
import type { JscpdModeOutcome } from "./mode-run.ts";
import { type JscpdNormalizedEvidence, normalizeJscpdReport } from "./normalize.ts";

/** Options for {@link runJscpdAnalysis}. */
export interface JscpdAnalysisOptions {
	/** Cancellation handle, propagated to staging, the adapter and every provider process. */
	signal?: AbortSignal;
	/** Pinned-tool resolution options — the documented test seam for located resolution failures. */
	resolve?: PinnedToolResolveOptions;
}

/** The identity a request for `mode` would run under (the supplied mode/option set, §16.2). */
function requestedIdentity(mode: CloneMatchMode) {
	return jscpdProviderIdentity(mode, JSCPD_DEFAULT_THRESHOLDS);
}

/** A located `unavailable`/`unsupported` result for a request that never executed. */
function neverRan(
	mode: CloneMatchMode,
	state: "unavailable" | "unsupported",
	reason: string,
): AnalysisResult {
	return { provider: requestedIdentity(mode), state, reason };
}

/**
 * The staged snapshot as accounted files: exactly the bytes the tool
 * consumed, classified into the measured production/test sets (accounting
 * inputs must match the staged selection — never a re-read of the target).
 */
async function accountedFiles(view: StagedWorkspaceView): Promise<JscpdAccountedFile[]> {
	const accounted: JscpdAccountedFile[] = [];
	for (const file of view.files) {
		if (file.sourceSet !== "production" && file.sourceSet !== "test") continue;
		accounted.push({
			path: file.path,
			sourceSet: file.sourceSet,
			text: await readFile(file.stagedPath, "utf8"),
		});
	}
	return accounted;
}

/** Per-source-set counts of the staged selection (the sets the analysis selected). */
function stagedBySourceSet(view: StagedWorkspaceView): Partial<Record<SourceSet, number>> {
	const bySourceSet: Partial<Record<SourceSet, number>> = {};
	for (const file of view.files) {
		bySourceSet[file.sourceSet] = (bySourceSet[file.sourceSet] ?? 0) + 1;
	}
	return bySourceSet;
}

/** Normalize one validated raw report over the staged snapshot; throws only on invalid evidence. */
async function normalizedEvidence(
	view: StagedWorkspaceView,
	outcome: JscpdModeOutcome,
): Promise<JscpdNormalizedEvidence> {
	if (!("report" in outcome) || outcome.report === undefined) {
		throw new Error("the outcome carries no raw report to normalize");
	}
	return normalizeJscpdReport(outcome.report, await accountedFiles(view));
}

/** Staging-level gaps as diagnostics: files the view could not read or refused to stage. */
function stagingDiagnostics(view: StagedWorkspaceView): AnalysisDiagnostic[] {
	return [
		...view.readFailures.map((failure) => ({ path: failure.path, message: failure.reason })),
		...view.rejected.map((rejection) => ({ path: rejection.path, message: rejection.reason })),
	];
}

/**
 * What an `incomplete` outcome observed: the enumerated analyzed files when
 * the account reconciles, plus the staging gaps — and always at least one
 * visible gap (missing files, a diagnostic, or the outcome's own reason),
 * because an incomplete analysis must show what could not be analyzed.
 */
function incompleteCoverage(
	view: StagedWorkspaceView,
	outcome: Extract<JscpdModeOutcome, { state: "incomplete" }>,
): ObservedCoverage {
	const analyzed = "coverage" in outcome ? (outcome.coverage?.analyzedFiles ?? []) : [];
	const diagnostics = stagingDiagnostics(view);
	const hasGap = analyzed.length !== view.files.length || diagnostics.length > 0;
	return {
		analyzedFiles: [...analyzed].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
		diagnostics: hasGap ? diagnostics : [...diagnostics, { message: outcome.reason }],
		unsupported: [],
	};
}

/**
 * Fold one adapter result (exactly one requested mode) into the contract
 * result over the staged view it ran on (see the module docblock). Runs
 * inside the staged lifecycle, before cleanup removes the snapshot.
 */
async function foldJscpdOutcome(
	view: StagedWorkspaceView,
	adapter: JscpdAdapterResult,
	mode: CloneMatchMode,
): Promise<AnalysisResult> {
	const outcome = adapter.outcomes[0];
	if (outcome === undefined || outcome.mode !== mode || adapter.outcomes.length !== 1) {
		throw new Error(
			`the jscpd adapter returned ${adapter.outcomes.length} outcomes for the single requested mode "${mode}"`,
		);
	}
	if (outcome.state !== "complete" && outcome.state !== "incomplete") {
		// The mode never ran (resolution or version failure, exhausted limits, an
		// unsupported host): located evidence with the actionable install
		// instructions appended — never a fabricated clean result.
		const reason =
			"instructions" in outcome && outcome.instructions !== undefined
				? `${outcome.reason} — ${outcome.instructions}`
				: outcome.reason;
		return neverRan(mode, outcome.state, reason);
	}
	if (outcome.state === "incomplete") {
		const base = {
			provider: outcome.provider,
			state: "incomplete" as const,
			analysis: outcome.analysis,
			reason: outcome.reason,
			observedCoverage: incompleteCoverage(view, outcome),
		};
		// Schema-valid raw evidence is still attached when it normalizes — what
		// the analysis did observe, never a fabricated zero.
		try {
			const normalized = await normalizedEvidence(view, outcome);
			return {
				...base,
				metrics: [...normalized.metrics],
				findings: [...normalized.findings],
				cloneEvidence: [...normalized.cloneEvidence],
			};
		} catch {
			return base;
		}
	}
	// state === "complete": full observed coverage over exactly the staged
	// selection, plus the normalized namespaced evidence. A normalization
	// failure degrades to incomplete with the located reason — never a crash,
	// never a clean result.
	try {
		const normalized = await normalizedEvidence(view, outcome);
		return {
			provider: outcome.provider,
			state: "complete",
			analysis: outcome.analysis,
			observedCoverage: {
				analyzedFiles: [...outcome.coverage.analyzedFiles],
				bySourceSet: stagedBySourceSet(view),
				diagnostics: [],
				unsupported: [],
			},
			metrics: [...normalized.metrics],
			findings: [...normalized.findings],
			cloneEvidence: [...normalized.cloneEvidence],
		};
	} catch (error) {
		return {
			provider: outcome.provider,
			state: "incomplete",
			analysis: outcome.analysis,
			reason: `validated jscpd evidence failed to normalize over the staged snapshot: ${messageOf(error)}`,
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
		// A cleanup failure is never a clean result: the complete evidence stays
		// attached, degraded to incomplete with the failure as its located gap.
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
 * Run the requested jscpd `mode` over an isolated staged view of `selection`
 * (the audit's measured production/test files) and return the contract
 * result (see the module docblock). Never throws for execution outcomes —
 * every failure is located evidence; only operational staging/configuration
 * errors reject, and the audit-side caller also folds those into located
 * `unavailable` evidence so a provider failure never aborts the audit.
 */
export async function runJscpdAnalysis(
	root: string,
	selection: readonly StagedSelectionFile[],
	mode: CloneMatchMode,
	options: JscpdAnalysisOptions = {},
): Promise<AnalysisResult> {
	if (selection.length === 0) {
		return neverRan(
			mode,
			"unsupported",
			"the measured production/test selection is empty — jscpd evidence requires at least one staged file to analyze",
		);
	}
	const request = {
		modes: [mode],
		thresholds: JSCPD_DEFAULT_THRESHOLDS,
		...(options.signal === undefined ? {} : { signal: options.signal }),
		...(options.resolve === undefined ? {} : { resolve: options.resolve }),
	};
	let lifecycle: StagedRunOutcome<AnalysisResult>;
	try {
		lifecycle = await withStagedWorkspaceView(
			{ root, files: selection },
			async (view) => await foldJscpdOutcome(view, await runJscpdAdapter(view, request), mode),
			options.signal === undefined ? {} : { signal: options.signal },
		);
	} catch (error) {
		// Staging could not be prepared at all (invalid request data or an
		// unusable root/scratch) — the provider cannot run, and the native
		// audit must survive it: located unavailable evidence (§16.3).
		const reason =
			error instanceof InvalidStagingRequestError || error instanceof StagingError
				? error.message
				: `staging failed unexpectedly: ${messageOf(error)}`;
		return neverRan(mode, "unavailable", reason);
	}
	switch (lifecycle.kind) {
		case "completed":
			return degradedForCleanup(lifecycle.value, lifecycle.cleanup);
		case "adapter-failed":
			return degradedForCleanup(
				neverRan(mode, "unavailable", `the jscpd adapter failed: ${messageOf(lifecycle.error)}`),
				lifecycle.cleanup,
			);
		case "cancelled":
			return degradedForCleanup(
				neverRan(
					mode,
					"unavailable",
					"the audit was cancelled before the jscpd analysis completed; the provider process group was terminated and no evidence was produced",
				),
				lifecycle.cleanup,
			);
		case "timeout":
			return degradedForCleanup(
				neverRan(mode, "unavailable", "the jscpd analysis exceeded its wall-time limit"),
				lifecycle.cleanup,
			);
	}
}
