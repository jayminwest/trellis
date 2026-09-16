import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MetricValue, metricValueSchema } from "../contract/index.ts";
import { discoverSourceInventory } from "../discovery/index.ts";
import { buildSyntaxInventory, type SyntaxInventory } from "../syntax/index.ts";
import { analyzeDuplication, type DuplicationBudget } from "./index.ts";

let repo: string;

beforeEach(async () => {
	repo = await mkdtemp(join(tmpdir(), "trellis-duplication-analyze-"));
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

/** Build the shared syntax inventory for the current temp repo. */
async function inventory(): Promise<SyntaxInventory> {
	return buildSyntaxInventory(await discoverSourceInventory(repo));
}

/** Index `metrics` by id for direct lookups. */
function byId(metrics: readonly MetricValue[]): Map<string, MetricValue> {
	return new Map(metrics.map((metric) => [metric.id, metric]));
}

/** 63 normalized tokens over 7 lines — above the 50-token + 3-line minimum. */
const CLONE_FN =
	"export function alpha(a: number, b: number) {\n" +
	"\tconst s = a + b;\n" +
	"\tif (a > 0 && b > 0) return 1;\n" +
	"\tif (a > 1 && b > 1) return 2;\n" +
	"\tif (a > 2 && b > 2) return 3;\n" +
	"\treturn s;\n" +
	"}\n";

describe("analyzeDuplication metric emission", () => {
	test("emits sorted per-set metrics with numerator and denominator", async () => {
		await put("src/a.ts", CLONE_FN);
		await put("src/b.ts", CLONE_FN);
		const { metrics } = analyzeDuplication(await inventory());
		const ids = metrics.map((metric) => metric.id);
		expect(ids).toEqual([...ids].sort());
		const groups = byId(metrics).get("duplication.groups.production");
		expect(groups).toMatchObject({ state: "complete", value: 1, unit: "count" });
		const lines = byId(metrics).get("duplication.duplicated-lines.production");
		expect(lines).toMatchObject({
			state: "complete",
			value: 14,
			numerator: 14,
			denominator: 14,
		});
		const density = byId(metrics).get("duplication.density.production");
		expect(density).toMatchObject({ state: "complete", value: 1, numerator: 14, denominator: 14 });
	});

	test("a scope with no code lines has a not-applicable density and finite counts", async () => {
		await put("src/a.ts", "// only a comment\n");
		const { metrics } = analyzeDuplication(await inventory());
		// Every emitted metric satisfies the §6.1 contract — in particular no
		// numerator/denominator pair may carry a zero denominator (the contract
		// requires a positive denominator; trellis-ef85 surfaces this).
		for (const metric of metrics) metricValueSchema.parse(metric);
		const byIdMap = byId(metrics);
		expect(byIdMap.get("duplication.density.production")).toMatchObject({
			state: "not-applicable",
		});
		expect(byIdMap.get("duplication.density.production")?.value).toBeUndefined();
		expect(byIdMap.get("duplication.groups.production")).toMatchObject({
			state: "complete",
			value: 0,
		});
		expect(byIdMap.get("duplication.duplicated-lines.production")).toMatchObject({
			state: "complete",
			value: 0,
		});
		// No code lines → no compatible denominator → the pair is omitted entirely.
		expect(byIdMap.get("duplication.duplicated-lines.production")?.denominator).toBeUndefined();
		expect(byIdMap.get("duplication.duplicated-lines.test")?.denominator).toBeUndefined();
	});

	test("parse diagnostics make the scope incomplete with partial values", async () => {
		await put("src/a.ts", CLONE_FN);
		await put("src/b.ts", CLONE_FN);
		await put("src/broken.ts", "export function broken( {\n");
		const { scopes, metrics } = analyzeDuplication(await inventory());
		expect(scopes.production.diagnosticFiles).toEqual(["src/broken.ts"]);
		const groups = byId(metrics).get("duplication.groups.production");
		expect(groups?.state).toBe("incomplete");
		expect(groups?.value).toBe(1);
		expect(groups?.reason).toContain("parse diagnostics");
	});

	test("emits one finding per clone group with member evidence", async () => {
		await put("src/a.ts", CLONE_FN);
		await put("src/b.ts", CLONE_FN);
		const { findings } = analyzeDuplication(await inventory());
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			kind: "duplication.clone-group",
			path: "src/a.ts",
			range: { start: { line: 1 }, end: { line: 7 } },
		});
		expect(findings[0]?.facts).toMatchObject({
			groupId: "clone-group-1",
			sourceSet: "production",
			memberCount: 2,
			members: [
				{ path: "src/a.ts", startLine: 1, endLine: 7 },
				{ path: "src/b.ts", startLine: 1, endLine: 7 },
			],
		});
	});
});

describe("analyzeDuplication bounded feasibility", () => {
	test("token-budget exhaustion is incomplete with a reason, never a silent clean result", async () => {
		await put("src/a.ts", CLONE_FN);
		await put("src/b.ts", CLONE_FN);
		const budget: DuplicationBudget = { maxTokens: 10, maxMatchWork: 1_000_000 };
		const { scopes, metrics, findings } = analyzeDuplication(await inventory(), { budget });
		expect(scopes.production.exhaustion).toEqual({ kind: "token-count", limit: 10 });
		const byIdMap = byId(metrics);
		for (const id of [
			"duplication.groups.production",
			"duplication.duplicated-lines.production",
			"duplication.density.production",
		]) {
			const metric = byIdMap.get(id);
			expect(metric?.state).toBe("incomplete");
			expect(metric?.value).toBeUndefined();
			expect(metric?.reason).toContain("token budget of 10");
		}
		expect(findings).toHaveLength(0);
	});

	test("match-work exhaustion is incomplete with partial values and a reason", async () => {
		await put("src/a.ts", CLONE_FN);
		await put("src/b.ts", CLONE_FN);
		const budget: DuplicationBudget = { maxTokens: 1_000_000, maxMatchWork: 5 };
		const { scopes, metrics } = analyzeDuplication(await inventory(), { budget });
		expect(scopes.production.exhaustion).toEqual({ kind: "match-work", limit: 5 });
		const groups = byId(metrics).get("duplication.groups.production");
		expect(groups?.state).toBe("incomplete");
		expect(groups?.reason).toContain("match-work budget of 5");
	});

	test("default budgets measure a normal repo completely", async () => {
		await put("src/a.ts", CLONE_FN);
		await put("src/b.ts", CLONE_FN);
		const { scopes, metrics } = analyzeDuplication(await inventory());
		expect(scopes.production.exhaustion).toBeNull();
		expect(byId(metrics).get("duplication.groups.production")?.state).toBe("complete");
	});
});

describe("analyzeDuplication determinism", () => {
	test("identical content yields byte-equal measurements regardless of creation order", async () => {
		await put("src/a.ts", CLONE_FN);
		await put("src/b.ts", CLONE_FN);
		await put("src/c.ts", CLONE_FN);
		const first = analyzeDuplication(await inventory());
		const second = analyzeDuplication(await inventory());
		expect(JSON.stringify(second)).toBe(JSON.stringify(first));
	});
});
