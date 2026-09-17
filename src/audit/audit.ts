/**
 * The deterministic audit core (SPEC §4, trellis-ef85) — one core call that
 * audits a TS/TSX workspace end to end and assembles the §6.4 report:
 *
 *   configure → discover → parse (one shared inventory) → measure (the
 *   native capability registry's measured selection) → safeguards → score
 *   (pure, provisional formula) → assemble report
 *
 * Since trellis-1e66 the measure phase consumes the registered native
 * analyzers (`src/analysis/`, trellis-cb51) instead of calling the four
 * analyzers inline: the registry owns selection and execution order,
 * {@link measureAnalyses} runs each selected analyzer through its registered
 * wrapper over the one shared parse, and assembly folds whatever the selected
 * execution list produced — no analyzer is hardcoded into the pipeline.
 * Native behavior is unchanged: the wrapped products are the existing
 * analyzers' outputs, so metrics, findings, ordering, score, safeguards and
 * the report bytes are identical to the pre-refactor baseline (proven by the
 * orchestration payload-equality tests), and no external provider is
 * selected or started — the registry holds native analyzers only at this
 * stage.
 *
 * Invariants (SPEC §8):
 *
 * - **No model, no network, no credentials** — local parsing and arithmetic
 *   only; there is nothing to connect.
 * - **No project commands** — the target's scripts are never executed and
 *   its executable configuration is never imported.
 * - **No database, zero footprint** — the run writes nothing; persistence
 *   (trellis-424d) and policy evaluation (trellis-942c) live outside the
 *   measurement pass and consume the returned report.
 * - **No Git required** — dirty worktrees and non-Git directories are
 *   analyzed exactly as they exist on disk.
 *
 * Determinism (SPEC §3.5): same files + same configuration + same
 * analyzer/scoring versions ⇒ equal measurement payload
 * ({@link import("../contract/index.ts").measurementPayload}). The only
 * nondeterministic fields are run metadata (`run.auditedAt`,
 * `run.durationMs`), which are excluded from the payload; `now` exists so
 * callers can pin the timestamp.
 *
 * Partial analysis is honest (SPEC §3.3): parse failures, unresolved
 * imports, and resource-budget exhaustion degrade the affected metrics to
 * `incomplete` with reasons — the report's completeness rollup and the
 * `partial` headline flag follow mechanically, and every other analyzer's
 * findings remain fully usable.
 */
import {
	NATIVE_REGISTRY,
	type NativeAnalysisRun,
	type NativeAnalyzer,
	runComplexityAnalysis,
	runDependencyGraphAnalysis,
	runDuplicationAnalysis,
	runImportCycleAnalysis,
	runSafeguardInspection,
} from "../analysis/index.ts";
import { loadAuditConfig } from "../config/index.ts";
import type { AuditConfig, AuditReport } from "../contract/index.ts";
import { discoverSourceInventory, type SourceInventory } from "../discovery/index.ts";
import type { DependencyGraphAnalysis, DuplicationBudget } from "../metrics/index.ts";
import { scoreSloppiness } from "../scoring/index.ts";
import { buildSyntaxInventory, type SyntaxInventory } from "../syntax/index.ts";
import {
	type AuditMeasurements,
	assembleReport,
	collectMetrics,
	type MeasuredAnalysis,
} from "./assemble.ts";
import { type AuditEvent, type AuditProgress, analyzerProgressId } from "./progress.ts";

/** Options for {@link auditWorkspace}. */
export interface AuditCoreOptions {
	/**
	 * Preloaded audit configuration (§6.5); when absent, `trellis.yaml` is
	 * loaded from the audited root (documented defaults when no file exists).
	 */
	config?: AuditConfig;
	/**
	 * Duplication resource budgets (SPEC §5.3 bounded feasibility); defaults
	 * to the documented {@link import("../metrics/index.ts").DEFAULT_DUPLICATION_BUDGET}.
	 * A resource knob, never a scoring input.
	 */
	duplicationBudget?: DuplicationBudget;
	/**
	 * Optional bounded progress sink ({@link AuditEvent}); the CLI renders
	 * these to stderr. Absent → a silent run with an identical report.
	 */
	onProgress?: AuditProgress;
	/** Wall-clock for `run.auditedAt` (determinism hook); defaults to now. */
	now?: Date;
}

/** Options for {@link measureAnalyses}. */
export interface MeasureAnalysesOptions {
	/** Duplication resource budget (SPEC §5.3); defaults to the analyzer's documented budget. */
	duplicationBudget?: DuplicationBudget;
	/** Optional progress sink receiving the per-analyzer events of the measure phase. */
	onProgress?: AuditProgress;
}

/**
 * The measured analyzers the audit executes: every analyzer in the native
 * capability registry that declares metrics, in the registry's execution
 * order (prerequisites first). The non-scoring safeguard inspection declares
 * no metrics, so it is never selected here — it runs in its own phase. The
 * selection is derived from registry declarations, never hardcoded: a newly
 * registered measured analyzer joins the execution list (and fails fast
 * below until its run is wired).
 */
export function selectedMeasuredAnalyzers(): readonly NativeAnalyzer[] {
	return NATIVE_REGISTRY.ordered().filter((analyzer) => analyzer.metrics.length > 0);
}

/**
 * Run every selected measured native analyzer over the shared passes (one
 * discovery, one shared parse — {@link measureAnalyses} takes them as inputs
 * and never re-derives them) and return the registered runs in execution
 * order, each carrying the analyzer's unchanged product plus its typed
 * contract result. The graph-dependent cycle analyzer consumes the exact
 * graph run the dependency-graph analyzer produced in the same pass. Emits
 * one `analyzer` event per selected analyzer with `index`/`total` derived
 * from the execution list. Sync and pure over the passes: no I/O, no clock.
 */
export function measureAnalyses(
	source: SourceInventory,
	syntax: SyntaxInventory,
	options: MeasureAnalysesOptions = {},
): readonly NativeAnalysisRun<MeasuredAnalysis>[] {
	const emit = (event: AuditEvent): void => options.onProgress?.(event);
	const execution = selectedMeasuredAnalyzers();
	const runs: NativeAnalysisRun<MeasuredAnalysis>[] = [];
	let graphRun: NativeAnalysisRun<DependencyGraphAnalysis> | undefined;
	for (const [index, analyzer] of execution.entries()) {
		emit({
			type: "analyzer",
			id: analyzerProgressId(analyzer.identity.id),
			index,
			total: execution.length,
		});
		switch (analyzer.identity.id) {
			case "trellis.complexity":
				runs.push(runComplexityAnalysis(syntax));
				break;
			case "trellis.duplication":
				runs.push(
					runDuplicationAnalysis(
						syntax,
						options.duplicationBudget === undefined ? {} : { budget: options.duplicationBudget },
					),
				);
				break;
			case "trellis.dependency-graph":
				graphRun = runDependencyGraphAnalysis(source, syntax);
				runs.push(graphRun);
				break;
			case "trellis.import-cycles": {
				if (graphRun === undefined) {
					throw new Error(
						'analyzer "trellis.import-cycles" executed before its prerequisite ' +
							'"trellis.dependency-graph" produced a graph',
					);
				}
				runs.push(runImportCycleAnalysis(graphRun));
				break;
			}
			default:
				throw new Error(`measured analyzer "${analyzer.identity.id}" has no wired native run`);
		}
	}
	return runs;
}

/**
 * Audit the workspace at `root` and return its §6.4 {@link AuditReport}
 * (see the module docblock for the invariants). Throws only on operational
 * errors — an unreadable root or an invalid `trellis.yaml`; source-level
 * problems are reported as `incomplete` metrics, never thrown.
 */
export async function auditWorkspace(
	root: string,
	options: AuditCoreOptions = {},
): Promise<AuditReport> {
	const emit = (event: AuditEvent): void => options.onProgress?.(event);
	const startedAt = Date.now();

	emit({ type: "phase", phase: "configure" });
	const config = options.config ?? (await loadAuditConfig(root));

	emit({ type: "phase", phase: "discover" });
	const source = await discoverSourceInventory(root, { source: config.source });
	emit({
		type: "source-discovered",
		files: source.files.length,
		packages: source.packages.length,
		excluded: source.excluded.length,
		unsupported: source.unsupported.files,
	});

	emit({ type: "phase", phase: "parse" });
	const syntax = await buildSyntaxInventory(source);
	emit({
		type: "syntax-built",
		files: syntax.files.length,
		functions: syntax.functionCount,
		diagnostics: syntax.diagnostics.length,
	});

	emit({ type: "phase", phase: "measure" });
	const runs = measureAnalyses(source, syntax, {
		...(options.duplicationBudget === undefined
			? {}
			: { duplicationBudget: options.duplicationBudget }),
		...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
	});
	// The registered runs carry their products' metrics and findings by
	// reference — folding the products is folding the results' evidence.
	const analyses = runs.map((run) => run.product);
	const metrics = collectMetrics(analyses);
	emit({
		type: "measured",
		metrics: metrics.length,
		findings: analyses.reduce((sum, analysis) => sum + analysis.findings.length, 0),
	});

	emit({ type: "phase", phase: "safeguards" });
	const { product: safeguards } = await runSafeguardInspection(source.root);
	emit({
		type: "safeguards-inspected",
		results: safeguards.results.length,
		findings: safeguards.findings.length,
	});

	emit({ type: "phase", phase: "score" });
	const scoring = scoreSloppiness(metrics);
	emit({ type: "scored", index: scoring.index, partial: scoring.partial });

	emit({ type: "phase", phase: "assemble" });
	const measurements: AuditMeasurements = { source, syntax, analyses, safeguards };
	return assembleReport(measurements, scoring, {
		auditedAt: (options.now ?? new Date()).toISOString(),
		durationMs: Date.now() - startedAt,
	});
}
