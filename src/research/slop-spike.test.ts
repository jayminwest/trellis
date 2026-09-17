import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureFunctionComplexity } from "../metrics/complexity.ts";
import {
	collectFunctions,
	countLines,
	type FileSyntax,
	parseSource,
	type SyntaxInventory,
} from "../syntax/index.ts";
import { forwarderAt } from "./slop-signals.ts";
import { measureSlopHypotheses, runSlopSpike } from "./slop-spike.ts";

function inventory(sources: Record<string, string>): SyntaxInventory {
	const files: FileSyntax[] = Object.entries(sources).map(([path, text]) => {
		const parsed = parseSource(path, text);
		return {
			...parsed,
			...collectFunctions(parsed.sourceFile),
			path,
			packagePath: ".",
			sourceSet: path.endsWith(".test.ts") ? "test" : "production",
			lines: countLines(parsed.sourceFile),
		};
	});
	const diagnostics = files.flatMap((file) => file.diagnostics);
	return {
		root: "/fixture",
		compilerVersion: "fixture",
		files,
		functionCount: files.reduce((sum, file) => sum + file.functions.length, 0),
		diagnostics,
		completeness: diagnostics.length ? "incomplete" : "complete",
	};
}

function probe(source: string) {
	return measureSlopHypotheses(inventory({ "example.ts": source }));
}

function dispatch(expression: string, values: string[]) {
	return `switch (${expression}) {
		${values.map((value) => `case ${JSON.stringify(value)}: break;`).join("\n")}
	}`;
}

describe("measureSlopHypotheses", () => {
	test("exposes added forwarding layers while maximum complexity stays flat", () => {
		const direct = "function core(x: number) { return x + 1; }";
		const layered = `${direct}
			function service(x: number) { return core(x); }
			const facade = (x: number) => service(x);`;
		const maxCc = (source: string) =>
			Math.max(
				...inventory({ "a.ts": source }).files.flatMap((file) =>
					file.functions.map((fn) => measureFunctionComplexity(fn).cc),
				),
			);
		expect(maxCc(direct)).toBe(maxCc(layered));
		expect(probe(direct).forwarders).toHaveLength(0);
		expect(probe(layered).forwarders.map((site) => site.target)).toEqual(["core", "service"]);
	});

	test("retains legitimate facade and callback controls as evidence against a slop count", () => {
		const result = probe(`export function sdk(request) { return core(request); }
			const matches = values.filter(value => accepted.has(value));`);
		expect(result.forwarders.map((site) => site.name)).toEqual(["sdk", "(anonymous)"]);
		expect(result.status).toBe("experimental-evidence-only");
	});

	test("preserves wrapper facts under local renaming, comments and parentheses", () => {
		const a = probe("const wrap = (x) => target(x);").forwarders[0];
		const b = probe("const renamed = (value) => (target(/* comment */ (value)));").forwarders[0];
		expect(a?.parameters).toBe(b?.parameters);
		expect(a?.target).toBe(b?.target);
		expect(b?.range.start.line).toBe(1);
	});

	test("excludes transformations, defaults, reordered arguments and additional work", () => {
		const rejected = [
			"function f(x) { log(x); return g(x); }",
			"const f = (x) => g(x + 1);",
			"const f = (x = 1) => g(x);",
			"const f = (...xs) => g(...xs);",
			"const f = ({x}) => g(x);",
			"const f = (x, y) => g(y, x);",
			"const f = (x) => g(x, 1);",
			"const f = (x) => g?.(x);",
			"async function f(x) { return await g(x); }",
			"function f() { return; }",
			"class A { constructor() {} }",
		];
		for (const source of rejected) expect(probe(source).forwarders).toEqual([]);
		expect(probe("async function f(x) { return g(x); }").forwarders[0]?.isAsync).toBe(true);
		expect(probe("const f = () => g();").forwarders[0]?.parameters).toBe(0);
	});

	test("guards a non-function passed through the internal facts boundary", () => {
		const file = inventory({ "a.ts": "const f = () => g();" }).files[0];
		const fn = file?.functions[0];
		if (!file || !fn) throw new Error("missing fixture");
		expect(forwarderAt(file, { ...fn, node: file.sourceFile })).toBeUndefined();
	});

	test("detects repeated decisions and their removal by consolidation", () => {
		const cases = ["json", "markdown", "terminal"];
		const scattered = measureSlopHypotheses(
			inventory({
				"encode.ts": dispatch("format", cases),
				"suffix.ts": dispatch("output", [...cases].reverse()),
			}),
		);
		expect(scattered.dispatchFamilies[0]?.fileCount).toBe(2);
		expect(scattered.dispatchFamilies[0]?.siteCount).toBe(2);
		expect(probe(dispatch("format", cases)).dispatchFamilies).toEqual([]);
	});

	test("reports a case disagreement without declaring an omitted case a bug", () => {
		const result = probe(
			dispatch("format", ["json", "md", "text"]) + dispatch("output", ["json", "md"]),
		);
		expect(result.dispatchDisagreements.pairs[0]?.onlyLeft).toEqual(['string:"text"']);
		expect(result.dispatchDisagreements.pairs[0]?.onlyRight).toEqual([]);
		expect(result.dispatchFamilies).toEqual([]);
	});

	test("exposes unrelated domains as a confounder and a lookup table as a blind spot", () => {
		const independent = probe(
			dispatch("traffic", ["red", "green"]) + dispatch("paint", ["red", "green"]),
		);
		expect(independent.dispatchFamilies).toHaveLength(1);
		const lookup = probe("const a = {json: 1, md: 2}; const b = {json: 3, md: 4};");
		expect(lookup.dispatchFamilies).toEqual([]);
	});

	test("normalizes static labels and reports defaults without assuming their behavior", () => {
		const result = probe(`switch (x) { case ('a'): break; case \`b\`: break; default: break; }
			switch (y) { case 'b': break; case 'a': break; }
			switch (z) { case 1: break; case 2: break; }
			switch (w) { case '1': break; case '2': break; }`);
		expect(result.dispatchFamilies).toHaveLength(1);
		expect(result.dispatches.map((site) => site.hasDefault)).toEqual([true, false, false, false]);
		expect(probe("switch (x) {case A: break; case 'b': break;}").dispatches).toEqual([]);
		expect(probe(dispatch("x", ["a", "a"])).dispatches).toEqual([]);
	});

	test("visits nested switches once and keeps independent clean additions from erasing sites", () => {
		const source = `function outer() { return () => { ${dispatch("x", ["a", "b"])} }; }`;
		const before = probe(source);
		const after = probe(`${source}\nfunction unrelated() { return 42; }`);
		expect(before.dispatches).toHaveLength(1);
		expect(after.dispatches).toEqual(before.dispatches);
	});

	test("keeps output stable under file enumeration order and isolates source sets", () => {
		const input = inventory({
			"b.ts": dispatch("x", ["a", "b"]),
			"a.ts": dispatch("y", ["a", "b", "c"]),
			"a.test.ts": "const f = x => g(x);",
		});
		const first = measureSlopHypotheses(input);
		expect(first.forwarders).toEqual([]);
		expect(first.scope.files).toBe(2);
		expect(measureSlopHypotheses({ ...input, files: [...input.files].reverse() })).toEqual(first);
	});

	test("reports malformed files and bounded comparison as incomplete", () => {
		const malformed = probe("function broken( {");
		expect(malformed.completeness).toBe("incomplete");
		expect(malformed.scope.skipped).toEqual(["example.ts"]);
		const large = probe(
			Array.from({ length: 1001 }, (_, i) => dispatch(`x${i}`, ["a", "b"])).join("\n"),
		);
		expect(large.dispatchDisagreements.state).toBe("incomplete");
		expect(large.dispatchDisagreements.reason).toContain("1000");
		expect(large.dispatchDisagreements.pairs).toEqual([]);
	});
});

describe("runSlopSpike", () => {
	test("uses workspace configuration and reads real files without dependencies", async () => {
		const root = await mkdtemp(join(tmpdir(), "trellis-spike-"));
		try {
			await writeFile(join(root, "a.ts"), "export const wrap = x => core(x);");
			const first = await runSlopSpike(root);
			expect(first.forwarders).toHaveLength(1);
			await writeFile(join(root, "trellis.yaml"), "source:\n  exclude: [a.ts]\n");
			const second = await runSlopSpike(root);
			expect(second.forwarders).toEqual([]);
			expect(second.excluded).toEqual([{ path: "a.ts", reason: "config-exclude" }]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
