import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analysisResultSchema, type MetricValue } from "../contract/index.ts";
import type { SourceInventory } from "../discovery/index.ts";
import { discoverSourceInventory } from "../discovery/index.ts";
import {
	analyzeComplexity,
	analyzeCycles,
	analyzeDependencyGraph,
	analyzeDuplication,
} from "../metrics/index.ts";
import { inspectSafeguards } from "../safeguards/index.ts";
import { buildSyntaxInventory, type SyntaxInventory } from "../syntax/index.ts";
import {
	NATIVE_ANALYZER_IDS,
	NATIVE_REGISTRY,
	nativeScoringRequiredIds,
	runComplexityAnalysis,
	runDependencyGraphAnalysis,
	runDuplicationAnalysis,
	runImportCycleAnalysis,
	runSafeguardInspection,
} from "./native.ts";
import { toContractResult } from "./result.ts";

let repo: string;

beforeEach(async () => {
	repo = await mkdtemp(join(tmpdir(), "trellis-native-registry-"));
});

afterEach(async () => {
	await rm(repo, { recursive: true, force: true });
});

/** Write `content` to `relPath` under the temp repo, creating parent dirs. */
async function put(relPath: string, content: string): Promise<void> {
	const abs = join(repo, relPath);
	await mkdir(join(abs, ".."), { recursive: true });
	await writeFile(abs, content);
}

/**
 * 105 normalized tokens over 13 lines — above the 100-token + 3-line clone
 * minimum (mirrors the duplication analyzer fixtures) — placed in two files
 * that import each other, so the fixture exercises a real clone group, a
 * real import cycle, and a real local edge set.
 */
const CLONE_FN =
	"export function alpha(a: number, b: number) {\n" +
	"\tconst s = a + b;\n" +
	"\tif (a > 0) return 1;\n" +
	"\tif (a > 1) return 2;\n" +
	"\tif (a > 2) return 3;\n" +
	"\tif (a > 3) return 4;\n" +
	"\tif (a > 4) return 5;\n" +
	"\tif (a > 5) return 6;\n" +
	"\tif (a > 6) return 7;\n" +
	"\tif (a > 7) return 8;\n" +
	"\tif (a > 8) return 9;\n" +
	"\treturn s;\n" +
	"}\n";

/** Build the shared passes over the current temp repo. */
async function passes(): Promise<{ source: SourceInventory; syntax: SyntaxInventory }> {
	const source = await discoverSourceInventory(repo);
	return { source, syntax: await buildSyntaxInventory(source) };
}

/** The wrapped result must validate as a contract view (products stripped). */
function parsesContract(view: ReturnType<typeof toContractResult>): void {
	expect(analysisResultSchema.parse(view)).toEqual(view);
}

/** Metric ids emitted by `metrics`, sorted. */
function metricIds(metrics: readonly MetricValue[]): string[] {
	return metrics.map((metric) => metric.id).sort();
}

/** The registry's declared ids for one analyzer, sorted. */
function declaredMetrics(id: string): string[] {
	return [...(NATIVE_REGISTRY.get(id)?.metrics ?? [])].sort();
}

describe("native registry", () => {
	test("registers the supported native analyzers addressable by id", () => {
		expect(NATIVE_REGISTRY.analyzers.map((analyzer) => analyzer.identity.id)).toEqual([
			...NATIVE_ANALYZER_IDS,
		]);
		expect(NATIVE_REGISTRY.has("trellis.safeguards")).toBe(true);
	});

	test("declares the graph-to-cycle prerequisite and orders it first", () => {
		expect(NATIVE_REGISTRY.get("trellis.import-cycles")?.requires).toEqual([
			"trellis.dependency-graph",
		]);
		expect(NATIVE_REGISTRY.ordered().map((analyzer) => analyzer.identity.id)).toEqual([
			"trellis.complexity",
			"trellis.dependency-graph",
			"trellis.duplication",
			"trellis.import-cycles",
			"trellis.safeguards",
		]);
	});

	test("derives the scoring catalog's required analyses without the safeguard inspection", () => {
		expect(nativeScoringRequiredIds()).toEqual([
			"trellis.complexity",
			"trellis.dependency-graph",
			"trellis.duplication",
			"trellis.import-cycles",
		]);
		expect(NATIVE_REGISTRY.get("trellis.safeguards")?.metrics).toEqual([]);
	});
});

describe("runComplexityAnalysis", () => {
	test("returns the existing analyzer's complete product unchanged", async () => {
		await put("package.json", JSON.stringify({ name: "app" }));
		await put("src/a.ts", CLONE_FN);
		const { syntax } = await passes();
		const run = runComplexityAnalysis(syntax);
		expect(run.product).toEqual(analyzeComplexity(syntax));
		expect(run.result.metrics).toEqual(run.product.metrics);
		expect(run.result.findings).toEqual(run.product.findings);
		parsesContract(toContractResult(run.result));
	});

	test("declares exactly the metric ids the analyzer emits", async () => {
		await put("package.json", JSON.stringify({ name: "app" }));
		await put("src/a.ts", CLONE_FN);
		const { syntax } = await passes();
		expect(declaredMetrics("trellis.complexity")).toEqual(
			metricIds(runComplexityAnalysis(syntax).product.metrics),
		);
	});

	test("marks a scope with parse diagnostics incomplete with a coverage gap", async () => {
		await put("package.json", JSON.stringify({ name: "app" }));
		await put("src/a.ts", CLONE_FN);
		await put("src/broken.ts", "export function broken( {\n");
		const { syntax } = await passes();
		const run = runComplexityAnalysis(syntax);
		expect(run.result.state).toBe("incomplete");
		expect(run.result.reason).toBe(
			"1 selected file(s) produced parse diagnostics; metric values are partial",
		);
		expect(run.result.observedCoverage.diagnostics).toEqual([
			{ path: "src/broken.ts", message: expect.stringContaining("expected") },
		]);
		parsesContract(toContractResult(run.result));
	});
});

describe("runDuplicationAnalysis", () => {
	test("returns the existing analyzer's complete product unchanged", async () => {
		await put("package.json", JSON.stringify({ name: "app" }));
		await put("src/a.ts", `${CLONE_FN}import { alpha as beta } from "./b.ts";\n`);
		await put("src/b.ts", `${CLONE_FN}import { alpha } from "./a.ts";\n`);
		const { syntax } = await passes();
		const run = runDuplicationAnalysis(syntax);
		expect(run.product).toEqual(analyzeDuplication(syntax));
		expect(run.result.metrics).toEqual(run.product.metrics);
		expect(run.result.findings).toEqual(run.product.findings);
		parsesContract(toContractResult(run.result));
	});

	test("exposes clone groups as typed internal product and contract evidence", async () => {
		await put("package.json", JSON.stringify({ name: "app" }));
		await put("src/a.ts", CLONE_FN);
		await put("src/b.ts", CLONE_FN);
		const { syntax } = await passes();
		const run = runDuplicationAnalysis(syntax);
		const groups = [...run.product.scopes.production.groups, ...run.product.scopes.test.groups];
		expect(run.result.products?.clones).toEqual({ groups });
		expect(run.result.cloneEvidence).toEqual(
			groups.map((group) => ({
				kind: "group",
				matchMode: "normalized",
				members: group.members
					.map((member) => ({ path: member.path, range: member.range }))
					.sort((a, b) => a.path.localeCompare(b.path) || a.range.start.line - b.range.start.line),
			})),
		);
	});

	test("records the resource budget as declarative analysis options", async () => {
		await put("package.json", JSON.stringify({ name: "app" }));
		await put("src/a.ts", CLONE_FN);
		const { syntax } = await passes();
		const budget = { maxTokens: 5000, maxMatchWork: 6000 };
		const run = runDuplicationAnalysis(syntax, { budget });
		expect(run.product).toEqual(analyzeDuplication(syntax, { budget }));
		expect(run.result.analysis.options).toEqual({
			"max-tokens": 5000,
			"max-match-work": 6000,
			"work-accounting": "v2",
			"max-streams": 100_000,
			"max-working-cells": 32_000_000,
			"max-groups": 200_000,
			"max-occurrences": 1_000_000,
		});
		parsesContract(toContractResult(run.result));
	});

	test("declares exactly the metric ids the analyzer emits", async () => {
		await put("package.json", JSON.stringify({ name: "app" }));
		await put("src/a.ts", CLONE_FN);
		const { syntax } = await passes();
		expect(declaredMetrics("trellis.duplication")).toEqual(
			metricIds(runDuplicationAnalysis(syntax).product.metrics),
		);
	});
});

describe("runDependencyGraphAnalysis", () => {
	test("returns the existing analyzer's complete product unchanged", async () => {
		await put("package.json", JSON.stringify({ name: "app" }));
		await put("src/a.ts", `${CLONE_FN}import { alpha as beta } from "./b.ts";\n`);
		await put("src/b.ts", `${CLONE_FN}import { alpha } from "./a.ts";\n`);
		const { source, syntax } = await passes();
		const run = runDependencyGraphAnalysis(source, syntax);
		expect(run.product).toEqual(analyzeDependencyGraph(source, syntax));
		expect(run.result.metrics).toEqual(run.product.metrics);
		parsesContract(toContractResult(run.result));
	});

	test("makes the graph available as the typed internal product", async () => {
		await put("package.json", JSON.stringify({ name: "app" }));
		await put("src/a.ts", `${CLONE_FN}import { alpha as beta } from "./b.ts";\n`);
		const { source, syntax } = await passes();
		const run = runDependencyGraphAnalysis(source, syntax);
		expect(run.result.products?.graph).toEqual({
			nodes: run.product.graph.nodes,
			edges: run.product.graph.edges,
		});
		// The serialized evidence never carries ASTs or internal caches (AC2).
		expect(JSON.stringify(toContractResult(run.result))).not.toContain("sourceFile");
		expect(JSON.stringify(run.result.products)).not.toContain("sourceFile");
	});

	test("declares exactly the metric ids the analyzer emits", async () => {
		await put("package.json", JSON.stringify({ name: "app" }));
		await put("src/a.ts", CLONE_FN);
		const { source, syntax } = await passes();
		expect(declaredMetrics("trellis.dependency-graph")).toEqual(
			metricIds(runDependencyGraphAnalysis(source, syntax).product.metrics),
		);
	});
});

describe("runImportCycleAnalysis", () => {
	test("returns the existing analyzer's complete product unchanged", async () => {
		await put("package.json", JSON.stringify({ name: "app" }));
		await put("src/a.ts", `${CLONE_FN}import { alpha as beta } from "./b.ts";\n`);
		await put("src/b.ts", `${CLONE_FN}import { alpha } from "./a.ts";\n`);
		const { source, syntax } = await passes();
		const graph = runDependencyGraphAnalysis(source, syntax);
		const run = runImportCycleAnalysis(graph);
		expect(run.product).toEqual(analyzeCycles(graph.product));
		expect(run.product.groups.length).toBeGreaterThan(0);
		expect(run.result.metrics).toEqual(run.product.metrics);
		expect(run.result.findings).toEqual(run.product.findings);
		parsesContract(toContractResult(run.result));
	});

	test("consumes the declared graph run's identity and coverage", async () => {
		await put("package.json", JSON.stringify({ name: "app" }));
		await put("src/a.ts", `${CLONE_FN}import { alpha as beta } from "./b.ts";\n`);
		await put("src/b.ts", `${CLONE_FN}import { alpha } from "./a.ts";\n`);
		const { source, syntax } = await passes();
		const graph = runDependencyGraphAnalysis(source, syntax);
		const run = runImportCycleAnalysis(graph);
		expect(run.result.state).toBe(graph.result.state);
		expect(run.result.analysis).toEqual(graph.result.analysis);
		expect(run.result.observedCoverage).toEqual(graph.result.observedCoverage);
	});

	test("declares exactly the metric ids the analyzer emits", async () => {
		await put("package.json", JSON.stringify({ name: "app" }));
		await put("src/a.ts", `${CLONE_FN}import { alpha as beta } from "./b.ts";\n`);
		await put("src/b.ts", `${CLONE_FN}import { alpha } from "./a.ts";\n`);
		const { source, syntax } = await passes();
		const graph = runDependencyGraphAnalysis(source, syntax);
		expect(declaredMetrics("trellis.import-cycles")).toEqual(
			metricIds(runImportCycleAnalysis(graph).product.metrics),
		);
	});
});

describe("runSafeguardInspection", () => {
	test("returns the existing inspection's complete product unchanged", async () => {
		await put("package.json", JSON.stringify({ name: "app" }));
		const run = await runSafeguardInspection(repo);
		expect(run.product).toEqual(await inspectSafeguards(repo));
		expect(run.product.results.map((result) => result.id)).toHaveLength(8);
	});
});
