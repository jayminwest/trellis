import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MetricValue } from "../contract/index.ts";
import { discoverSourceInventory, type SourceInventory } from "../discovery/index.ts";
import { buildSyntaxInventory, type SyntaxInventory } from "../syntax/index.ts";
import { analyzeDependencyGraph } from "./analyze-graph.ts";
import { GRAPH_POLICY_VERSION, type GraphEdge } from "./graph-types.ts";

let repo: string;

beforeEach(async () => {
	repo = await mkdtemp(join(tmpdir(), "trellis-graph-analyze-"));
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

/** Discover + parse + analyze over the current temp repo. */
async function analyze(): Promise<{
	source: SourceInventory;
	syntax: SyntaxInventory;
	analysis: ReturnType<typeof analyzeDependencyGraph>;
}> {
	const source = await discoverSourceInventory(repo);
	const syntax = await buildSyntaxInventory(source);
	return { source, syntax, analysis: analyzeDependencyGraph(source, syntax) };
}

/** Index `metrics` by id for direct lookups. */
function byId(metrics: readonly MetricValue[]): Map<string, MetricValue> {
	return new Map(metrics.map((metric) => [metric.id, metric]));
}

/** Project edges to their comparable shape. */
function projectEdges(edges: readonly GraphEdge[]) {
	return edges.map((edge) => ({
		from: edge.from,
		kind: edge.kind,
		typeOnly: edge.typeOnly,
		specifier: edge.specifier,
		resolution: edge.resolution,
	}));
}

/** The acceptance fixture: aliases, package exports, extension mapping, barrels, workspace boundary, dynamic imports. */
async function putWorkspace(): Promise<void> {
	await put("package.json", JSON.stringify({ name: "app", workspaces: ["packages/*"] }));
	await put(
		"tsconfig.json",
		JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/*"] } } }),
	);
	await put(
		"packages/core/package.json",
		JSON.stringify({ name: "@acme/core", exports: { ".": "./src/index.ts" } }),
	);
	// Barrel: the package entry re-exports its modules; consumers import the barrel.
	await put(
		"packages/core/src/index.ts",
		'export * from "./utils";\nexport { flags } from "./flags";\n',
	);
	await put("packages/core/src/utils.ts", "export const util = 1;\n");
	await put("packages/core/src/flags.ts", "export const flags = 2;\n");
	await put(
		"src/app.ts",
		'import { util } from "@acme/core";\n' + // workspace boundary via package name
			'import type { Flags } from "@app/types";\n' + // tsconfig alias, type-only
			'import { helper } from "./helper.js";\n' + // extension mapping
			'import { sub } from "./sub";\n' + // barrel directory import
			'import zod from "zod";\n' + // external
			'const lazy = () => import("./lazy");\n' + // literal dynamic
			"export const app = [util, helper, sub, zod, lazy] as unknown as Flags;\n",
	);
	await put("src/types.ts", "export interface Flags {\n\tflags: number;\n}\n");
	await put("src/helper.ts", "export const helper = 1;\n");
	await put("src/sub/index.ts", "export const sub = 1;\n");
	await put("src/lazy.ts", "export const lazy = 1;\n");
}

describe("analyzeDependencyGraph over the workspace fixture", () => {
	test("resolves aliases, package exports, extension mapping, barrels, and dynamic imports", async () => {
		await putWorkspace();
		const { analysis } = await analyze();
		expect(projectEdges(analysis.graph.edges)).toEqual([
			{
				from: "packages/core/src/index.ts",
				kind: "re-export",
				typeOnly: false,
				specifier: "./utils",
				resolution: { status: "local", target: "packages/core/src/utils.ts" },
			},
			{
				from: "packages/core/src/index.ts",
				kind: "re-export",
				typeOnly: false,
				specifier: "./flags",
				resolution: { status: "local", target: "packages/core/src/flags.ts" },
			},
			{
				from: "src/app.ts",
				kind: "import",
				typeOnly: false,
				specifier: "@acme/core",
				resolution: { status: "local", target: "packages/core/src/index.ts" },
			},
			{
				from: "src/app.ts",
				kind: "import",
				typeOnly: true,
				specifier: "@app/types",
				resolution: { status: "local", target: "src/types.ts" },
			},
			{
				from: "src/app.ts",
				kind: "import",
				typeOnly: false,
				specifier: "./helper.js",
				resolution: { status: "local", target: "src/helper.ts" },
			},
			{
				from: "src/app.ts",
				kind: "import",
				typeOnly: false,
				specifier: "./sub",
				resolution: { status: "local", target: "src/sub/index.ts" },
			},
			{
				from: "src/app.ts",
				kind: "import",
				typeOnly: false,
				specifier: "zod",
				resolution: { status: "external", packageName: "zod" },
			},
			{
				from: "src/app.ts",
				kind: "dynamic",
				typeOnly: false,
				specifier: "./lazy",
				resolution: { status: "local", target: "src/lazy.ts" },
			},
		]);
		expect(analysis.graph.completeness).toBe("complete");
		expect(analysis.findings).toEqual([]);
	});

	test("nodes cover every classified file with ownership; configs and policy are traceable", async () => {
		await putWorkspace();
		const { analysis } = await analyze();
		expect(analysis.graph.policyVersion).toBe(GRAPH_POLICY_VERSION);
		expect(analysis.graph.nodes.map((node) => [node.path, node.packagePath])).toEqual([
			["packages/core/src/flags.ts", "packages/core"],
			["packages/core/src/index.ts", "packages/core"],
			["packages/core/src/utils.ts", "packages/core"],
			["src/app.ts", "."],
			["src/helper.ts", "."],
			["src/lazy.ts", "."],
			["src/sub/index.ts", "."],
			["src/types.ts", "."],
		]);
		expect(analysis.graph.configs).toEqual([{ path: "tsconfig.json", status: "parsed" }]);
		expect(analysis.graph.externals).toEqual([{ name: "zod", edges: 1 }]);
	});

	test("emits sorted metrics with the type-only/kind split in detail", async () => {
		await putWorkspace();
		const { analysis } = await analyze();
		const ids = analysis.metrics.map((metric) => metric.id);
		expect(ids).toEqual([...ids].sort());
		const metrics = byId(analysis.metrics);
		expect(metrics.get("graph.files")).toMatchObject({ state: "complete", value: 8 });
		expect(metrics.get("graph.edges.local")).toMatchObject({
			state: "complete",
			value: 7,
			unit: "count",
			detail: { typeOnly: 1, reExports: 2, dynamic: 1, outOfScope: 0 },
		});
		expect(metrics.get("graph.edges.external")).toMatchObject({
			state: "complete",
			value: 1,
			detail: { packages: 1 },
		});
		expect(metrics.get("graph.edges.unresolved")).toMatchObject({
			state: "complete",
			value: 0,
			detail: { policyVersion: GRAPH_POLICY_VERSION },
		});
	});

	test("is deterministic — two analyses over the same tree are byte-equal", async () => {
		await putWorkspace();
		const first = await analyze();
		const second = await analyze();
		expect(JSON.stringify(second.analysis)).toBe(JSON.stringify(first.analysis));
	});
});

describe("analyzeDependencyGraph incompleteness surfacing", () => {
	test("unresolved local edges are incomplete, found, and distinguishable from externals", async () => {
		await put("package.json", JSON.stringify({ name: "app", workspaces: ["packages/*"] }));
		await put("packages/core/package.json", JSON.stringify({ name: "@acme/core" }));
		await put(
			"src/app.ts",
			'import { gone } from "./gone";\n' + // relative, no target
				'import { sealed } from "@acme/core/secret";\n' + // workspace, no entry
				'import zod from "zod";\n' + // external — NOT unresolved
				"export const app = [gone, sealed, zod];\n",
		);
		const { analysis } = await analyze();
		expect(analysis.graph.completeness).toBe("incomplete");
		const metrics = byId(analysis.metrics);
		const unresolved = metrics.get("graph.edges.unresolved");
		expect(unresolved?.state).toBe("incomplete");
		expect(unresolved?.value).toBe(2);
		expect(unresolved?.reason).toContain("2 local import edge(s)");
		// External and resolved-local edges stay complete: externals are distinct.
		expect(metrics.get("graph.edges.external")).toMatchObject({ state: "complete", value: 1 });
		expect(analysis.findings.map((finding) => [finding.path, finding.facts])).toEqual([
			[
				"src/app.ts",
				{ specifier: "./gone", edgeKind: "import", typeOnly: false, reason: "no-target" },
			],
			[
				"src/app.ts",
				{
					specifier: "@acme/core/secret",
					edgeKind: "import",
					typeOnly: false,
					reason: "no-target",
				},
			],
		]);
		expect(analysis.findings[0]?.range.start.line).toBe(1);
		expect(analysis.findings[1]?.range.start.line).toBe(2);
	});

	test("a non-literal dynamic import is surfaced as an opaque finding without incompleteness", async () => {
		await put(
			"src/app.ts",
			"declare const name: string;\nexport const lazy = () => import(name);\n",
		);
		const { analysis } = await analyze();
		expect(analysis.findings).toHaveLength(1);
		expect(analysis.findings[0]?.facts).toMatchObject({
			specifier: null,
			edgeKind: "dynamic",
			reason: "non-literal-dynamic",
		});
		expect(byId(analysis.metrics).get("graph.edges.unresolved")).toMatchObject({
			state: "complete",
			value: 1,
			detail: { nonLiteralDynamic: 1 },
		});
		expect(analysis.graph.completeness).toBe("complete");
	});

	test("a non-literal dynamic import beside a resolvable miss stays incomplete for the miss only", async () => {
		await put(
			"src/app.ts",
			'import "./gone";\ndeclare const name: string;\nexport const lazy = () => import(name);\n',
		);
		const { analysis } = await analyze();
		const unresolved = byId(analysis.metrics).get("graph.edges.unresolved");
		expect(unresolved).toMatchObject({ state: "incomplete", value: 2 });
		expect(unresolved?.reason).toContain("1 local import edge(s) could not be resolved");
		expect(analysis.graph.completeness).toBe("incomplete");
	});

	test("parse diagnostics make edge metrics incomplete with partial values", async () => {
		await put("src/ok.ts", 'import "./other";\nexport const ok = 1;\n');
		await put("src/other.ts", "export const other = 1;\n");
		await put("src/broken.ts", "export function broken( {\n");
		const { analysis } = await analyze();
		const metrics = byId(analysis.metrics);
		expect(metrics.get("graph.files")).toMatchObject({ state: "complete", value: 3 });
		const local = metrics.get("graph.edges.local");
		expect(local?.state).toBe("incomplete");
		expect(local?.value).toBe(1);
		expect(local?.reason).toContain("1 file(s) produced parse diagnostics");
		expect(analysis.graph.completeness).toBe("incomplete");
	});

	test("an empty workspace reports finite zeros, all complete", async () => {
		const { analysis } = await analyze();
		expect(analysis.graph.nodes).toEqual([]);
		expect(analysis.graph.edges).toEqual([]);
		for (const metric of analysis.metrics) expect(metric.state).toBe("complete");
		expect(analysis.graph.completeness).toBe("complete");
	});
});
