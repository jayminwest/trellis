#!/usr/bin/env bun
/**
 * Corpus record model for the fixed-corpus validation harness (SPEC §14
 * stage 10, trellis-e924): report summarization, single-entry review
 * checks, paired-refactor assessment, and the markdown record rendering.
 * Pure functions over `AuditReport` summaries — see
 * `scripts/validate-corpus.ts` for measurement and the CLI.
 */

import type { AuditReport } from "../src/contract/index.ts";
import type { CorpusPair, MetricCheck } from "./validate-corpus.ts";

/** Metric ids captured per entry: the six formula terms plus review support. */
const SUMMARY_METRIC_IDS = [
	"complexity.cc.max.production",
	"complexity.functions.production",
	"duplication.density.production",
	"duplication.density.test",
	"duplication.duplicated-lines.production",
	"duplication.groups.production",
	"duplication.groups.test",
	"erosion.eroded-count.production",
	"erosion.eroded-count.test",
	"erosion.eroded-share.production",
	"erosion.mass.production",
	"import-cycle.density",
	"import-cycle.groups",
	"import-cycle.modules",
] as const;

/** One metric's value/state at summary granularity (`null` when not numeric). */
export interface MetricSnapshot {
	state: string;
	value: number | null;
}

/** The audit facts the record keeps per corpus entry. */
export interface EntrySummary {
	id: string;
	index: number;
	partial: boolean;
	completeness: string;
	productionFiles: number;
	productionSloc: number;
	testFiles: number;
	testSloc: number;
	metrics: Record<string, MetricSnapshot>;
}

/** Project an §6.4 report to its corpus summary. */
export function summarizeReport(id: string, report: AuditReport): EntrySummary {
	const metrics: Record<string, MetricSnapshot> = {};
	for (const metricId of SUMMARY_METRIC_IDS) {
		const metric = report.metrics[metricId];
		metrics[metricId] = {
			state: metric?.state ?? "absent",
			value: typeof metric?.value === "number" ? metric.value : null,
		};
	}
	return {
		id,
		index: report.score.index,
		partial: report.score.partial,
		completeness: report.completeness,
		productionFiles: report.sourceCoverage.production.files,
		productionSloc: report.sourceCoverage.production.sloc ?? 0,
		testFiles: report.sourceCoverage.test.files,
		testSloc: report.sourceCoverage.test.sloc ?? 0,
		metrics,
	};
}

/** The outcome of one manifest check against an entry summary. */
export interface CheckResult {
	target: string;
	ok: boolean;
	detail: string;
}

function checkActual(summary: EntrySummary, target: string): unknown {
	if (target === "index") return summary.index;
	if (target === "partial") return summary.partial;
	if (target === "completeness") return summary.completeness;
	return summary.metrics[target]?.value ?? null;
}

function evaluateOne(actual: unknown, check: MetricCheck): { ok: boolean; want: string } {
	if (check.eq !== undefined) return { ok: actual === check.eq, want: `== ${check.eq}` };
	if (check.gt !== undefined) {
		return { ok: typeof actual === "number" && actual > check.gt, want: `> ${check.gt}` };
	}
	if (check.ge !== undefined) {
		return { ok: typeof actual === "number" && actual >= check.ge, want: `>= ${check.ge}` };
	}
	if (check.lt !== undefined) {
		return { ok: typeof actual === "number" && actual < check.lt, want: `< ${check.lt}` };
	}
	if (check.le !== undefined) {
		return { ok: typeof actual === "number" && actual <= check.le, want: `<= ${check.le}` };
	}
	return { ok: false, want: "a check operator" };
}

/** Evaluate the manifest `checks` of one single-role entry. */
export function evaluateChecks(
	summary: EntrySummary,
	checks: Record<string, MetricCheck>,
): CheckResult[] {
	return Object.entries(checks).map(([target, check]) => {
		if (check.state !== undefined) {
			const state =
				target === "completeness" ? summary.completeness : summary.metrics[target]?.state;
			return {
				target,
				ok: state === check.state,
				detail: `${target} state ${state ?? "absent"} (want ${check.state})`,
			};
		}
		const actual = checkActual(summary, target);
		const { ok, want } = evaluateOne(actual, check);
		return { target, ok, detail: `${target} ${JSON.stringify(actual)} (want ${want})` };
	});
}

/** One metric's before/after movement in a paired refactor. */
export interface MetricDelta {
	before: number | null;
	after: number | null;
	delta: number | null;
}

/** A paired-refactor verdict: intended moves checked, everything else reported. */
export interface PairAssessment {
	id: string;
	indexBefore: number;
	indexAfter: number;
	indexDelta: number;
	deltas: Record<string, MetricDelta>;
	failures: string[];
}

/** Assess one controlled pair against its manifest expectations. */
export function assessPair(
	pair: CorpusPair,
	before: EntrySummary,
	after: EntrySummary,
): PairAssessment {
	const deltas: Record<string, MetricDelta> = {};
	const failures: string[] = [];
	const ids = [...pair.expectDecrease, ...pair.expectIncrease, ...pair.expectUnchanged];
	for (const id of ids) {
		const b = before.metrics[id]?.value ?? null;
		const a = after.metrics[id]?.value ?? null;
		deltas[id] = { before: b, after: a, delta: b !== null && a !== null ? a - b : null };
		const failure = metricExpectationFailure(pair, id, b, a);
		if (failure !== null) failures.push(failure);
	}
	const indexDelta = after.index - before.index;
	const indexFailure = indexExpectationFailure(pair, indexDelta);
	if (indexFailure !== null) failures.push(indexFailure);
	return {
		id: pair.id,
		indexBefore: before.index,
		indexAfter: after.index,
		indexDelta,
		deltas,
		failures,
	};
}

/** The failure message when metric `id` breaks its pair expectation, else null. */
function metricExpectationFailure(
	pair: CorpusPair,
	id: string,
	b: number | null,
	a: number | null,
): string | null {
	if (pair.expectDecrease.includes(id) && (a === null || b === null || a >= b)) {
		return `${id} should decrease (${b} → ${a})`;
	}
	if (pair.expectIncrease.includes(id) && (a === null || b === null || a <= b)) {
		return `${id} should increase (${b} → ${a})`;
	}
	if (pair.expectUnchanged.includes(id) && a !== b) {
		return `${id} should be unchanged (${b} → ${a})`;
	}
	return null;
}

/** The failure message when the index delta breaks its pair bounds, else null. */
function indexExpectationFailure(pair: CorpusPair, indexDelta: number): string | null {
	if (pair.indexDelta?.min !== undefined && indexDelta < pair.indexDelta.min) {
		return `index delta ${indexDelta} below minimum ${pair.indexDelta.min}`;
	}
	if (pair.indexDelta?.max !== undefined && indexDelta > pair.indexDelta.max) {
		return `index delta ${indexDelta} above maximum ${pair.indexDelta.max}`;
	}
	return null;
}

/** One measured entry row in the markdown record. */
export interface EntryRow {
	id: string;
	summary: EntrySummary;
	medianMs: number;
	peakRssMb: number;
	budgetBreaches: string[];
}

/** The record shape `formatMarkdown` renders. */
export interface CorpusRecordView {
	environment: {
		revision: string;
		analyzerVersion: string;
		scoringVersion: string;
		schemaVersion: string;
		bun: string;
		typescript: string;
		platform: string;
		arch: string;
		cpu: string;
		memoryMb: number;
	};
	entries: EntryRow[];
	checkResults: Record<string, CheckResult[]>;
	pairs: PairAssessment[];
	ok: boolean;
}

function fmtMetric(value: number | null): string {
	return value === null ? "n/a" : Number(value.toFixed(4)).toString();
}

/** Render the record as the markdown skeleton for `docs/corpus-validation.md`. */
export function formatMarkdown(record: CorpusRecordView): string {
	const env = record.environment;
	const lines: string[] = [
		"# Corpus validation record",
		"",
		"## Environment",
		"",
		`| revision | ${env.revision} |`,
		`| analyzer / scoring / schema | ${env.analyzerVersion} / ${env.scoringVersion} / ${env.schemaVersion} |`,
		`| runtime | Bun ${env.bun}, typescript ${env.typescript}, ${env.platform} ${env.arch} |`,
		`| machine | ${env.cpu}, ${env.memoryMb} MiB |`,
		"",
		"## Entries",
		"",
		"| entry | prod files | prod sloc | index | partial | median ms | peak MiB | budget |",
		"|---|---|---|---|---|---|---|---|",
	];
	for (const observation of record.entries) {
		const verdict =
			observation.budgetBreaches.length === 0 ? "ok" : observation.budgetBreaches.join("; ");
		lines.push(
			`| ${observation.id} | ${observation.summary.productionFiles} | ${observation.summary.productionSloc} | ${observation.summary.index} | ${observation.summary.partial} | ${observation.medianMs.toFixed(0)} | ${observation.peakRssMb.toFixed(0)} | ${verdict} |`,
		);
	}
	lines.push("", "## Pairs", "");
	for (const pair of record.pairs) {
		lines.push(`### ${pair.id} (index ${pair.indexBefore} → ${pair.indexAfter})`, "");
		lines.push("| metric | before | after | delta |", "|---|---|---|---|");
		for (const [id, delta] of Object.entries(pair.deltas)) {
			lines.push(
				`| ${id} | ${fmtMetric(delta.before)} | ${fmtMetric(delta.after)} | ${fmtMetric(delta.delta)} |`,
			);
		}
		lines.push(
			"",
			pair.failures.length === 0
				? "expectations: all held"
				: `FAILURES: ${pair.failures.join("; ")}`,
			"",
		);
	}
	lines.push("## Checks", "");
	for (const [id, results] of Object.entries(record.checkResults)) {
		for (const result of results) {
			lines.push(`- ${result.ok ? "ok" : "FAIL"} ${id}: ${result.detail}`);
		}
	}
	lines.push("", `overall: ${record.ok ? "ok" : "FAIL"}`, "");
	return lines.join("\n");
}
