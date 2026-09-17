import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MetricValue } from "../contract/index.ts";
import { discoverSourceInventory } from "../discovery/index.ts";
import { buildSyntaxInventory } from "../syntax/index.ts";
import { analyzeComplexity } from "./analyze.ts";

let repo: string;

beforeEach(async () => {
	repo = await mkdtemp(join(tmpdir(), "trellis-metrics-"));
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

/** Discover, parse, and analyze the current temp repo. */
async function analyze() {
	return analyzeComplexity(await buildSyntaxInventory(await discoverSourceInventory(repo)));
}

/** Index `metrics` by id for direct lookups. */
function byId(metrics: readonly MetricValue[]): Map<string, MetricValue> {
	return new Map(metrics.map((metric) => [metric.id, metric]));
}

/**
 * Hand-calculated hotspot: 9 code lines, decisions = 5 ifs × 2 (if + &&)
 * → CC 11 > 10 (eroded), mass = 11 × √9 = 33.
 */
const HOT_FUNCTION =
	"export function hot(a: number, b: number) {\n" + // 1
	"\tconst s = a + b;\n" + // 2
	"\tif (a > 0 && b > 0) return 1;\n" + // 3
	"\tif (a > 1 && b > 1) return 2;\n" + // 4
	"\tif (a > 2 && b > 2) return 3;\n" + // 5
	"\tif (a > 3 && b > 3) return 4;\n" + // 6
	"\tif (a > 4 && b > 4) return 5;\n" + // 7
	"\treturn s;\n" + // 8
	"}\n"; // 9

/**
 * Hand-calculated calm function: 9 code lines, no decisions → CC 1,
 * mass = 1 × √9 = 3.
 */
const CALM_FUNCTION =
	"export function calm() {\n" + // 1
	"\tconst a = 1;\n" + // 2
	"\tconst b = 2;\n" + // 3
	"\tconst c = a + b;\n" + // 4
	"\tconst d = c * 2;\n" + // 5
	"\tconst e = d - 1;\n" + // 6
	"\tconst f = e + a;\n" + // 7
	"\treturn f;\n" + // 8
	"}\n"; // 9

/**
 * Second hotspot shape: 8 code lines, 10 case clauses → CC 11 (eroded),
 * mass = 11 × √8 ≈ 31.113.
 */
const SWITCH_FUNCTION =
	"export function zap(a: number): number {\n" + // 1
	"\tswitch (a) {\n" + // 2
	"\t\tcase 1: return 1; case 2: return 2; case 3: return 3;\n" + // 3
	"\t\tcase 4: return 4; case 5: return 5; case 6: return 6;\n" + // 4
	"\t\tcase 7: return 7; case 8: return 8; case 9: return 9;\n" + // 5
	"\t\tcase 10: return 10; default: return 0;\n" + // 6
	"\t}\n" + // 7
	"}\n"; // 8

describe("analyzeComplexity", () => {
	test("measures production and test source separately with hand-calculated values", async () => {
		await put("package.json", JSON.stringify({ name: "app" }));
		// 4 code lines, one if → CC 2, mass = 2 × √4 = 4, nesting 1.
		await put(
			"src/f.ts",
			"export function f(a: number) {\n" + "\tif (a > 0) return a;\n" + "\treturn 0;\n" + "}\n",
		);
		// 1 code line, no decisions → CC 1, mass = 1 × √1 = 1.
		await put("src/f.test.ts", "test('f', () => { expect(1).toBe(1); });\n");

		const analysis = await analyze();

		expect(analysis.scopes.production.functionCount).toBe(1);
		expect(analysis.scopes.production.mass).toBe(4);
		expect(analysis.scopes.production.erodedShare).toBe(0);
		expect(analysis.scopes.test.functionCount).toBe(1);
		expect(analysis.scopes.test.mass).toBe(1);

		const f = analysis.functions.find((fn) => fn.name === "f");
		expect(f).toMatchObject({
			path: "src/f.ts",
			sourceSet: "production",
			cc: 2,
			maxNesting: 1,
			sloc: 4,
			mass: 4,
			eroded: false,
		});

		const metrics = byId(analysis.metrics);
		expect(metrics.get("complexity.functions.production")).toMatchObject({
			state: "complete",
			value: 1,
			unit: "count",
			detail: { files: 1, sloc: 4 },
		});
		expect(metrics.get("complexity.cc.p50.production")).toMatchObject({
			state: "complete",
			value: 2,
		});
		expect(metrics.get("complexity.cc.max.production")).toMatchObject({ value: 2 });
		expect(metrics.get("complexity.nesting.max.production")).toMatchObject({ value: 1 });
		expect(metrics.get("erosion.eroded-share.production")).toMatchObject({
			state: "complete",
			value: 0,
			numerator: 0,
			denominator: 4,
		});
		// The test scope carries its own, separate numbers.
		expect(metrics.get("complexity.functions.test")).toMatchObject({ value: 1 });
		expect(metrics.get("erosion.eroded-share.test")).toMatchObject({
			value: 0,
			denominator: 1,
		});
		expect(analysis.findings).toEqual([]);
	});

	test("aggregates repo scope from summed masses, never averaged package shares", async () => {
		await put("package.json", JSON.stringify({ name: "mono", workspaces: ["packages/*"] }));
		await put("packages/big/package.json", JSON.stringify({ name: "big" }));
		await put("packages/big/src/hot.ts", HOT_FUNCTION); // mass 33, all eroded
		await put("packages/small/package.json", JSON.stringify({ name: "small" }));
		await put("packages/small/src/calm.ts", CALM_FUNCTION); // mass 3, none eroded

		const analysis = await analyze();
		const scope = analysis.scopes.production;

		// Summed masses: share = 33/36 ≈ 0.9167; averaging package shares
		// would give (1 + 0)/2 = 0.5 — the dilution SPEC §5.2 forbids.
		expect(scope.mass).toBe(36);
		expect(scope.erodedMass).toBe(33);
		expect(scope.erodedShare).toBe(33 / 36);
		expect(scope.erodedShare).not.toBe(0.5);
		expect(scope.packages).toEqual([
			{
				packagePath: "packages/big",
				files: 1,
				sloc: 9,
				functionCount: 1,
				mass: 33,
				erodedMass: 33,
				erodedCount: 1,
				erodedShare: 1,
			},
			{
				packagePath: "packages/small",
				files: 1,
				sloc: 9,
				functionCount: 1,
				mass: 3,
				erodedMass: 0,
				erodedCount: 0,
				erodedShare: 0,
			},
		]);

		const metrics = byId(analysis.metrics);
		const share = metrics.get("erosion.eroded-share.production");
		expect(share).toMatchObject({
			state: "complete",
			value: 0.916667,
			numerator: 33,
			denominator: 36,
		});
		expect(share?.detail).toMatchObject({
			thresholdCc: 10,
			packages: [
				{ packagePath: "packages/big", erodedShare: 1 },
				{ packagePath: "packages/small", erodedShare: 0 },
			],
		});
	});

	test("gives function-free scopes finite counts and not-applicable distributions", async () => {
		await put("package.json", JSON.stringify({ name: "app" }));
		await put("src/only.test.ts", "export const x: number = 1;\n");

		const analysis = await analyze();
		const metrics = byId(analysis.metrics);

		for (const set of ["production", "test"] as const) {
			expect(metrics.get(`complexity.functions.${set}`)).toMatchObject({
				state: "complete",
				value: 0,
			});
			expect(metrics.get(`erosion.mass.${set}`)).toMatchObject({ state: "complete", value: 0 });
			expect(metrics.get(`erosion.eroded-count.${set}`)).toMatchObject({
				state: "complete",
				value: 0,
			});
			for (const id of [
				`complexity.cc.p50.${set}`,
				`complexity.cc.p90.${set}`,
				`complexity.cc.max.${set}`,
				`complexity.nesting.max.${set}`,
				`erosion.eroded-share.${set}`,
			]) {
				const metric = metrics.get(id);
				expect(metric?.state, id).toBe("not-applicable");
				expect(metric?.value, id).toBeUndefined();
				expect(metric?.reason, id).toBeUndefined();
			}
		}
		expect(analysis.findings).toEqual([]);
	});

	test("flags scopes with parse diagnostics as incomplete with partial values", async () => {
		await put("package.json", JSON.stringify({ name: "app" }));
		await put("src/broken.ts", "export function broken( {\n");
		await put("src/ok.test.ts", "test('ok', () => { expect(1).toBe(1); });\n");

		const analysis = await analyze();
		const metrics = byId(analysis.metrics);

		const functions = metrics.get("complexity.functions.production");
		expect(functions?.state).toBe("incomplete");
		expect(functions?.reason).toContain("1 production file(s)");
		// The test scope is untouched and stays complete.
		expect(metrics.get("complexity.functions.test")?.state).toBe("complete");
		expect(metrics.get("erosion.eroded-share.test")).toMatchObject({ state: "complete" });
		expect(analysis.scopes.production.diagnosticFiles).toEqual(["src/broken.ts"]);
	});

	test("ranks hotspots by mass with exact paths, ranges, and per-set facts", async () => {
		await put("package.json", JSON.stringify({ name: "app" }));
		await put("src/hot.ts", HOT_FUNCTION); // mass 33, production
		await put("src/zap.ts", SWITCH_FUNCTION); // mass 11√8 ≈ 31.113, production
		await put("src/hot.test.ts", HOT_FUNCTION.replace("hot", "hotCase")); // mass 33, test

		const analysis = await analyze();

		// Deterministic order: mass desc, ties by path ("src/hot.test.ts" < "src/hot.ts").
		expect(analysis.findings.map((finding) => finding.path)).toEqual([
			"src/hot.test.ts",
			"src/hot.ts",
			"src/zap.ts",
		]);
		expect(analysis.findings[0]).toMatchObject({
			kind: "complexity.hotspot",
			summary: "CC 11, mass 33, nesting 1, SLOC 9",
			range: { start: { line: 1 }, end: { line: 9 } },
			facts: { rank: 1, name: "hotCase", sourceSet: "test", cc: 11, sloc: 9, mass: 33 },
		});
		expect(analysis.findings[1]).toMatchObject({
			range: { start: { line: 1 }, end: { line: 9 } },
			facts: { rank: 2, name: "hot", sourceSet: "production" },
		});
		expect(analysis.findings[2]).toMatchObject({
			range: { start: { line: 1 }, end: { line: 8 } },
			facts: { rank: 3, name: "zap", sourceSet: "production", mass: 31.113 },
		});
	});

	test("emits metrics sorted by id with no reason on complete metrics", async () => {
		await put("package.json", JSON.stringify({ name: "app" }));
		await put("src/f.ts", "export function f() {\n\treturn 1;\n}\n");

		const analysis = await analyze();
		const ids = analysis.metrics.map((metric) => metric.id);
		expect(ids).toEqual([...ids].sort());
		for (const metric of analysis.metrics) {
			if (metric.state === "complete") expect(metric.reason).toBeUndefined();
		}
	});

	test("is reproducible: the same inventory yields an equal measurement", async () => {
		await put("package.json", JSON.stringify({ name: "app" }));
		await put("src/hot.ts", HOT_FUNCTION);
		await put("src/calm.ts", CALM_FUNCTION);

		const inventory = await buildSyntaxInventory(await discoverSourceInventory(repo));
		expect(analyzeComplexity(inventory)).toEqual(analyzeComplexity(inventory));
	});
});
