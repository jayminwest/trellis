import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findingSchema, type MetricValue, metricValueSchema } from "../contract/index.ts";
import { discoverSourceInventory } from "../discovery/index.ts";
import { buildSyntaxInventory } from "../syntax/index.ts";
import { analyzeCycles, type CycleAnalysis } from "./analyze-cycles.ts";
import { analyzeDependencyGraph } from "./analyze-graph.ts";
import { CYCLE_POLICY_VERSION } from "./cycles.ts";
import type { DependencyGraphAnalysis } from "./graph-types.ts";

let repo: string;

beforeEach(async () => {
	repo = await mkdtemp(join(tmpdir(), "trellis-cycles-analyze-"));
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

/** Discover + parse + resolve + measure cycles over the current temp repo. */
async function analyze(): Promise<CycleAnalysis> {
	const source = await discoverSourceInventory(repo);
	const syntax = await buildSyntaxInventory(source);
	return analyzeCycles(analyzeDependencyGraph(source, syntax));
}

/** Index `metrics` by id for direct lookups. */
function byId(metrics: readonly MetricValue[]): Map<string, MetricValue> {
	return new Map(metrics.map((metric) => [metric.id, metric]));
}

/** Every emitted metric and finding satisfies the contract schemas (SPEC §6). */
function expectContractValid(analysis: CycleAnalysis): void {
	for (const metric of analysis.metrics) metricValueSchema.parse(metric);
	for (const finding of analysis.findings) findingSchema.parse(finding);
}

describe("analyzeCycles over an acyclic workspace", () => {
	test("reports zero groups with complete, finite metrics", async () => {
		await put("src/a.ts", 'import { b } from "./b";\nexport const a = b;\n');
		await put("src/b.ts", "export const b = 1;\n");
		const analysis = await analyze();
		expectContractValid(analysis);
		expect(analysis.policyVersion).toBe(CYCLE_POLICY_VERSION);
		expect(analysis.groups).toEqual([]);
		expect(analysis.packages).toEqual([]);
		expect(analysis.affectedModules).toBe(0);
		expect(analysis.findings).toEqual([]);
		const metrics = byId(analysis.metrics);
		expect(metrics.get("import-cycle.groups")).toMatchObject({ state: "complete", value: 0 });
		expect(metrics.get("import-cycle.modules")).toMatchObject({ state: "complete", value: 0 });
		expect(metrics.get("import-cycle.density")).toMatchObject({
			state: "complete",
			value: 0,
			unit: "ratio",
			numerator: 0,
			denominator: 2,
		});
	});
});

describe("analyzeCycles over disjoint cycles", () => {
	test("exposes both groups with stable ids and representative paths", async () => {
		await put("src/a.ts", 'import { b } from "./b";\nexport const a = b;\n');
		await put("src/b.ts", 'import { a } from "./a";\nexport const b = a;\n');
		await put("src/c.ts", 'import { d } from "./d";\nexport const c = d;\n');
		await put("src/d.ts", 'import { c } from "./c";\nexport const d = c;\n');
		await put("src/e.ts", "export const e = 1;\n");
		const analysis = await analyze();
		expectContractValid(analysis);
		expect(analysis.groups).toEqual([
			{
				id: "cycle-1",
				edgeClass: "runtime",
				members: ["src/a.ts", "src/b.ts"],
				packages: ["."],
				representativePath: ["src/a.ts", "src/b.ts", "src/a.ts"],
			},
			{
				id: "cycle-2",
				edgeClass: "runtime",
				members: ["src/c.ts", "src/d.ts"],
				packages: ["."],
				representativePath: ["src/c.ts", "src/d.ts", "src/c.ts"],
			},
		]);
		expect(analysis.affectedModules).toBe(4);
		const metrics = byId(analysis.metrics);
		expect(metrics.get("import-cycle.groups")).toMatchObject({
			state: "complete",
			value: 2,
			detail: { runtime: 2, typeOnly: 0, policyVersion: CYCLE_POLICY_VERSION, unresolvedEdges: 0 },
		});
		expect(metrics.get("import-cycle.density")).toMatchObject({
			state: "complete",
			value: 0.8,
			numerator: 4,
			denominator: 5,
		});
		expect(analysis.findings.map((finding) => finding.kind)).toEqual([
			"import-cycle",
			"import-cycle",
		]);
		expect(analysis.findings[0]).toMatchObject({
			path: "src/a.ts",
			range: { start: { line: 1 } },
			facts: { group: "cycle-1", edgeClass: "runtime", members: 2 },
		});
	});
});

describe("analyzeCycles over overlapping cycles", () => {
	test("merges overlapping cycles into one complete group", async () => {
		await put("src/a.ts", 'import { b } from "./b";\nexport const a = b;\n');
		await put(
			"src/b.ts",
			'import { a } from "./a";\nimport { c } from "./c";\nexport const b = [a, c];\n',
		);
		await put("src/c.ts", 'import { b } from "./b";\nexport const c = b;\n');
		const analysis = await analyze();
		expect(analysis.groups).toEqual([
			{
				id: "cycle-1",
				edgeClass: "runtime",
				members: ["src/a.ts", "src/b.ts", "src/c.ts"],
				packages: ["."],
				representativePath: ["src/a.ts", "src/b.ts", "src/a.ts"],
			},
		]);
		expect(analysis.affectedModules).toBe(3);
	});
});

describe("analyzeCycles over specified edge cases", () => {
	test("reports a self-import as a size-1 group", async () => {
		await put("src/self.ts", 'import { other } from "./self";\nexport const self = other;\n');
		const analysis = await analyze();
		expectContractValid(analysis);
		expect(analysis.groups).toEqual([
			{
				id: "cycle-1",
				edgeClass: "runtime",
				members: ["src/self.ts"],
				packages: ["."],
				representativePath: ["src/self.ts", "src/self.ts"],
			},
		]);
		expect(analysis.affectedModules).toBe(1);
		expect(byId(analysis.metrics).get("import-cycle.density")).toMatchObject({
			state: "complete",
			value: 1,
		});
	});

	test("reports a type-only cycle separately from runtime cycles", async () => {
		await put("src/a.ts", 'import type { B } from "./b";\nexport interface A {\n\tb: B;\n}\n');
		await put("src/b.ts", 'import type { A } from "./a";\nexport interface B {\n\ta: A;\n}\n');
		const analysis = await analyze();
		expectContractValid(analysis);
		expect(analysis.groups).toEqual([
			{
				id: "cycle-1",
				edgeClass: "type-only",
				members: ["src/a.ts", "src/b.ts"],
				packages: ["."],
				representativePath: ["src/a.ts", "src/b.ts", "src/a.ts"],
			},
		]);
		expect(byId(analysis.metrics).get("import-cycle.groups")).toMatchObject({
			value: 1,
			detail: { runtime: 0, typeOnly: 1 },
		});
	});

	test("does not fuse a runtime edge one way with a type-only edge the other", async () => {
		await put("src/a.ts", 'import { b } from "./b";\nexport const a = b;\n');
		await put("src/b.ts", 'import type { A } from "./a";\nexport const b = 1 as unknown as A;\n');
		const analysis = await analyze();
		expect(analysis.groups).toEqual([]);
		expect(byId(analysis.metrics).get("import-cycle.groups")).toMatchObject({
			state: "complete",
			value: 0,
		});
	});

	test("reports a group cyclic in both classes once per class without double-counting modules", async () => {
		await put(
			"src/a.ts",
			'import { b } from "./b";\nimport type { B } from "./b";\nexport const a = b as unknown as B;\n',
		);
		await put(
			"src/b.ts",
			'import { a } from "./a";\nimport type { A } from "./a";\nexport const b = a as unknown as A;\n',
		);
		const analysis = await analyze();
		expect(analysis.groups.map((group) => [group.id, group.edgeClass])).toEqual([
			["cycle-1", "runtime"],
			["cycle-2", "type-only"],
		]);
		// Repo-level affected modules are the union across classes: 2, not 4.
		expect(analysis.affectedModules).toBe(2);
		expect(byId(analysis.metrics).get("import-cycle.modules")).toMatchObject({
			value: 2,
			detail: { runtime: 2, typeOnly: 2 },
		});
		expect(byId(analysis.metrics).get("import-cycle.density")).toMatchObject({
			numerator: 2,
			denominator: 2,
			value: 1,
		});
	});
});

describe("analyzeCycles package and repo views", () => {
	test("preserves a cross-package cycle in both package views without double-counting", async () => {
		await put("package.json", JSON.stringify({ name: "app", workspaces: ["packages/*"] }));
		await put(
			"packages/a/package.json",
			JSON.stringify({ name: "@acme/a", exports: { ".": "./src/index.ts" } }),
		);
		await put(
			"packages/b/package.json",
			JSON.stringify({ name: "@acme/b", exports: { ".": "./src/index.ts" } }),
		);
		await put("packages/a/src/index.ts", 'import { b } from "@acme/b";\nexport const a = b;\n');
		await put("packages/b/src/index.ts", 'import { a } from "@acme/a";\nexport const b = a;\n');
		await put("packages/b/src/util.ts", "export const util = 1;\n");
		const analysis = await analyze();
		expectContractValid(analysis);
		expect(analysis.groups).toEqual([
			{
				id: "cycle-1",
				edgeClass: "runtime",
				members: ["packages/a/src/index.ts", "packages/b/src/index.ts"],
				packages: ["packages/a", "packages/b"],
				representativePath: [
					"packages/a/src/index.ts",
					"packages/b/src/index.ts",
					"packages/a/src/index.ts",
				],
			},
		]);
		expect(analysis.packages).toEqual([
			{ packagePath: "packages/a", modules: 1, affectedModules: 1, groups: ["cycle-1"] },
			{ packagePath: "packages/b", modules: 2, affectedModules: 1, groups: ["cycle-1"] },
		]);
		// Repo view: the union counts each module once across both package views.
		expect(analysis.affectedModules).toBe(2);
		expect(byId(analysis.metrics).get("import-cycle.density")).toMatchObject({
			numerator: 2,
			denominator: 3,
		});
	});
});

describe("analyzeCycles with unresolved graph coverage", () => {
	test("marks every cycle metric incomplete with the graph's reason and unresolved count", async () => {
		await put("src/a.ts", 'import { b } from "./b";\nexport const a = b;\n');
		await put(
			"src/b.ts",
			'import { a } from "./a";\nimport { gone } from "./missing";\nexport const b = [a, gone];\n',
		);
		const analysis = await analyze();
		expectContractValid(analysis);
		// The cycle over resolved edges is still measured…
		expect(analysis.groups.map((group) => group.id)).toEqual(["cycle-1"]);
		// …but every metric carries the unresolved coverage alongside (SPEC §3.3).
		for (const metric of analysis.metrics) {
			expect(metric.state).toBe("incomplete");
			expect(metric.reason).toContain("1 local import edge(s) could not be resolved");
		}
		expect(byId(analysis.metrics).get("import-cycle.groups")).toMatchObject({
			value: 1,
			detail: { unresolvedEdges: 1 },
		});
	});
});

describe("analyzeCycles determinism", () => {
	test("produces byte-equal results across graph enumeration order", () => {
		const nodes = ["m/a.ts", "m/b.ts", "m/c.ts", "m/d.ts"].map((path) => ({
			path,
			packagePath: "m",
			sourceSet: "production" as const,
		}));
		const edges = [
			{ from: "m/a.ts", to: "m/b.ts" },
			{ from: "m/b.ts", to: "m/c.ts" },
			{ from: "m/c.ts", to: "m/a.ts" },
			{ from: "m/c.ts", to: "m/d.ts" },
			{ from: "m/d.ts", to: "m/b.ts" },
		];
		const build = (nodeOrder: typeof nodes, edgeOrder: typeof edges): DependencyGraphAnalysis => ({
			graph: {
				policyVersion: "1.0.0",
				root: "/repo",
				nodes: nodeOrder,
				edges: edgeOrder.map(({ from, to }) => ({
					from,
					kind: "import" as const,
					typeOnly: false,
					specifier: to,
					range: { start: { line: 1 }, end: { line: 1 } },
					resolution: { status: "local" as const, target: to },
				})),
				externals: [],
				configs: [],
				completeness: "complete",
			},
			metrics: [],
			findings: [],
		});
		const reference = analyzeCycles(build(nodes, edges));
		const reversed = analyzeCycles(build([...nodes].reverse(), [...edges].reverse()));
		expect(JSON.stringify(reversed)).toBe(JSON.stringify(reference));
		expect(reference.groups).toEqual([
			{
				id: "cycle-1",
				edgeClass: "runtime",
				members: ["m/a.ts", "m/b.ts", "m/c.ts", "m/d.ts"],
				packages: ["m"],
				representativePath: ["m/a.ts", "m/b.ts", "m/c.ts", "m/a.ts"],
			},
		]);
	});
});
