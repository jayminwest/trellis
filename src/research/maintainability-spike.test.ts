import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pairs from "../../docs/research/maintainability-pairs.json";
import { auditWorkspace } from "../audit/audit.ts";
import type { CloneGroup } from "../metrics/duplication.ts";
import {
	collectFunctions,
	countLines,
	parseSource,
	type SyntaxInventory,
} from "../syntax/index.ts";
import { contextualizeClones } from "./maintainability-clones.ts";
import {
	measureMaintainability,
	measureMaintainabilityPairs,
	runMaintainabilitySpike,
	summarizeMaintainability,
} from "./maintainability-spike.ts";

function inventory(text: string, path = "example.ts"): SyntaxInventory {
	const parsed = parseSource(path, text);
	const facts = collectFunctions(parsed.sourceFile);
	return {
		root: "/fixture",
		compilerVersion: "fixture",
		functionCount: facts.functions.length,
		completeness: parsed.diagnostics.length ? "incomplete" : "complete",
		diagnostics: parsed.diagnostics,
		files: [
			{
				...parsed,
				...facts,
				path,
				packagePath: ".",
				sourceSet: "production",
				lines: countLines(parsed.sourceFile),
			},
		],
	};
}

function totals(source: string) {
	const report = measureMaintainability(inventory(source));
	return {
		flow: report.functions.reduce((sum, fn) => sum + fn.flow, 0),
		calls: report.functions.reduce((sum, fn) => sum + fn.calls, 0),
		maxCc: Math.max(...report.functions.map((fn) => fn.cc)),
	};
}

describe("maintainabilityPairs", () => {
	test("reproduces all eight pairs and exposes the shared-rule generalization ambiguity", () => {
		const results = measureMaintainabilityPairs();
		expect(results).toHaveLength(8);
		expect(results.every((pair) => pair.before.eroded === 0 && pair.after.eroded === 0)).toBe(true);
		expect(results.find((pair) => pair.id === "shared-rule")?.after.totalFlow).toBe(
			results.find((pair) => pair.id === "forced-generalization")?.after.totalFlow,
		);
	});
	for (const pair of pairs) {
		test(`checks bounded behavioral equivalence and the metric response for ${pair.id}`, async () => {
			// Trusted, committed JavaScript fixtures only; never execute audited source.
			const before: { run: (x: number) => number } = await import(
				`data:text/javascript,${encodeURIComponent(pair.before)}`
			);
			const after: { run: (x: number) => number } = await import(
				`data:text/javascript,${encodeURIComponent(pair.after)}`
			);
			for (let x = -20; x <= 40; x++) expect(after.run(x)).toBe(before.run(x));
			const a = totals(pair.before);
			const b = totals(pair.after);
			if (pair.prediction.startsWith("flow-decreases")) expect(b.flow).toBeLessThan(a.flow);
			else expect(b.flow).toBe(a.flow);
			if (pair.id === "helper-extraction" || pair.id === "forwarding-layers")
				expect(b.calls).toBeGreaterThan(a.calls);
		});
	}
});

describe("measureMaintainability", () => {
	test("isolates nested functions and treats switch branches separately from CC", () => {
		const result = measureMaintainability(
			inventory(`function outer(x) {
			return () => { switch(x) { case 1: return 1; case 2: return 2; default: return 0; } };
		}`),
		);
		expect(result.functions.map((fn) => [fn.cc, fn.flow])).toEqual([
			[1, 0],
			[3, 1],
		]);
		const summary = summarizeMaintainability(result);
		expect(summary.rankings.byFlow[0]?.flow).toBe(1);
		expect(summary.ccHistogram).toEqual({ 1: 1, 3: 1 });
	});
	test("counts loops, catches and ternaries but leaves optional access and null fallback unweighted", () => {
		const result = totals(`function run(x) { try { for(const item of x) {
			if(item) return item?.value ?? 0; } } catch(e) { return x ? 1 : 0; } return 0; }`);
		expect(result.flow).toBe(6);
	});
	test("reports parse gaps, excludes test functions and preserves enumeration invariance", () => {
		const broken = measureMaintainability(inventory("function broken( {"));
		expect(broken.skipped).toEqual(["example.ts"]);
		expect(broken.duplication.metrics.some((metric) => metric.state === "incomplete")).toBe(true);
		const input = inventory("export const f = x => x;", "b.ts");
		const other = inventory("export const g = x => x+1;", "a.ts");
		const combined = { ...input, files: [...input.files, ...other.files] };
		expect(measureMaintainability(combined)).toEqual(
			measureMaintainability({ ...combined, files: [...combined.files].reverse() }),
		);
		expect(
			measureMaintainability({
				...input,
				files: input.files.map((file) => ({ ...file, sourceSet: "test" })),
			}).functions,
		).toEqual([]);
	});
});

describe("contextualizeClones", () => {
	test("annotates actual native clone matches in a repeated registration chain", () => {
		const chain = Array.from(
			{ length: 24 },
			(_, i) => `.addOption(new Option('flag${i}', 'description${i}').hideHelp())`,
		).join("\n");
		const report = measureMaintainability(inventory(`command\n${chain};`));
		expect(report.duplication.state).toBe("complete");
		expect(report.summary.cloneGroups).toBeGreaterThan(0);
		expect(report.summary.registrationGroups).toBeGreaterThan(0);
		expect(report.summary.overlappingGroups).toBeGreaterThan(0);
	});
	test("locates registration syntax and line overlap without inferring safe removal", () => {
		const input = inventory(`command
			.addOption(new Option('a').hideHelp())
			.addOption(new Option('b').hideHelp())
			.addOption(new Option('c').hideHelp());`);
		const groups: CloneGroup[] = [
			{
				id: "example",
				tokenCount: 100,
				members: [
					{
						path: "example.ts",
						range: { start: { line: 1 }, end: { line: 3 } },
						tokenCount: 100,
						lineCount: 3,
					},
					{
						path: "example.ts",
						range: { start: { line: 2 }, end: { line: 4 } },
						tokenCount: 100,
						lineCount: 3,
					},
				],
			},
		];
		const result = contextualizeClones(groups, input.files);
		expect(result[0]?.lineOverlap).toBe(true);
		expect(result[0]?.members[0]?.context).toBe("registration-candidate");
		expect(contextualizeClones(groups, [])[0]?.members[0]?.context).toBe("unavailable");
		const branch = inventory("if(x) { run(); }\nconst y = 1;\nconst z = 2;");
		expect(contextualizeClones(groups, branch.files)[0]?.members[0]?.context).toBe("control-flow");
	});
});

describe("runMaintainabilitySpike", () => {
	test("reads a dependency-free workspace without writes or changes to native scoring", async () => {
		const root = await mkdtemp(join(tmpdir(), "maintainability-"));
		try {
			await writeFile(join(root, "example.ts"), pairs[0]?.before ?? "");
			await writeFile(join(root, "trellis.yaml"), "source:\n  exclude: [ignored.ts]\n");
			await writeFile(join(root, "ignored.ts"), "function broken( {");
			const before = await auditWorkspace(root);
			const result = await runMaintainabilitySpike(root);
			expect(result.summary.functions).toBe(1);
			expect(result.excluded).toContainEqual({ path: "ignored.ts", reason: "config-exclude" });
			expect((await auditWorkspace(root)).score).toEqual(before.score);
			expect((await readdir(root)).sort()).toEqual(["example.ts", "ignored.ts", "trellis.yaml"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
