/**
 * The deterministic audit core (SPEC §4, trellis-ef85) — one core call that
 * audits a TS/TSX workspace end to end and assembles the §6.4 report:
 *
 *   configure → discover → parse (one shared inventory) → measure
 *   (complexity, duplication, dependency graph, import cycles)
 *   → safeguards → score (pure, provisional formula) → assemble report
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
import { loadAuditConfig } from "../config/index.ts";
import type { AuditConfig, AuditReport } from "../contract/index.ts";
import { discoverSourceInventory } from "../discovery/index.ts";
import {
	analyzeComplexity,
	analyzeCycles,
	analyzeDependencyGraph,
	analyzeDuplication,
	type DuplicationBudget,
} from "../metrics/index.ts";
import { inspectSafeguards } from "../safeguards/index.ts";
import { scoreSloppiness } from "../scoring/index.ts";
import { buildSyntaxInventory } from "../syntax/index.ts";
import { type AuditMeasurements, assembleReport, collectMetrics } from "./assemble.ts";
import { ANALYZER_IDS, type AnalyzerId, type AuditEvent, type AuditProgress } from "./progress.ts";

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
	const analyzer = (id: AnalyzerId, index: number): void =>
		emit({ type: "analyzer", id, index, total: ANALYZER_IDS.length });
	analyzer("complexity", 0);
	const complexity = analyzeComplexity(syntax);
	analyzer("duplication", 1);
	const duplication = analyzeDuplication(
		syntax,
		options.duplicationBudget === undefined ? {} : { budget: options.duplicationBudget },
	);
	analyzer("dependency-graph", 2);
	const graph = analyzeDependencyGraph(source, syntax);
	analyzer("import-cycles", 3);
	const cycles = analyzeCycles(graph);
	const metricAnalyses = [complexity, duplication, graph, cycles];
	const metrics = collectMetrics(metricAnalyses);
	emit({
		type: "measured",
		metrics: metrics.length,
		findings: metricAnalyses.reduce((sum, analysis) => sum + analysis.findings.length, 0),
	});

	emit({ type: "phase", phase: "safeguards" });
	const safeguards = await inspectSafeguards(source.root);
	emit({
		type: "safeguards-inspected",
		results: safeguards.results.length,
		findings: safeguards.findings.length,
	});

	emit({ type: "phase", phase: "score" });
	const scoring = scoreSloppiness(metrics);
	emit({ type: "scored", index: scoring.index, partial: scoring.partial });

	emit({ type: "phase", phase: "assemble" });
	const measurements: AuditMeasurements = {
		source,
		syntax,
		complexity,
		duplication,
		graph,
		cycles,
		safeguards,
	};
	return assembleReport(measurements, scoring, {
		auditedAt: (options.now ?? new Date()).toISOString(),
		durationMs: Date.now() - startedAt,
	});
}
