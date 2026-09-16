import { describe, expect, test } from "bun:test";
import { collectFunctions, parseSource } from "../syntax/index.ts";
import { measureFunctionComplexity } from "./complexity.ts";

/** Parse `source` and measure every inventoried function, in source order. */
function measure(source: string): { name: string; cc: number; maxNesting: number }[] {
	const parsed = parseSource("fixture.ts", source);
	expect(parsed.diagnostics).toEqual([]);
	return collectFunctions(parsed.sourceFile).functions.map((fn) => ({
		name: fn.name,
		...measureFunctionComplexity(fn),
	}));
}

/** Measure the single function in `source`. */
function measureOne(source: string): { name: string; cc: number; maxNesting: number } {
	const results = measure(source);
	expect(results).toHaveLength(1);
	const [only] = results;
	if (only === undefined) throw new Error("expected one function");
	return only;
}

describe("measureFunctionComplexity", () => {
	test("gives an empty function CC 1 and nesting 0", () => {
		expect(measureOne("function f() {}\n")).toEqual({ name: "f", cc: 1, maxNesting: 0 });
	});

	test("counts each if/else-if as one decision and nests else-if chains", () => {
		// Two IfStatements → CC 3; the else-if's body sits inside both ifs → depth 2.
		const result = measureOne(
			"function f(a: number, b: number) {\n" +
				"\tif (a > 0) {\n" +
				"\t\treturn a;\n" +
				"\t} else if (b > 0) {\n" +
				"\t\treturn b;\n" +
				"\t}\n" +
				"\treturn 0;\n" +
				"}\n",
		);
		expect(result).toEqual({ name: "f", cc: 3, maxNesting: 2 });
	});

	test("counts every loop kind once", () => {
		// for + for-in + for-of + while + do = 5 decisions → CC 6, each loop one level.
		const result = measureOne(
			"function f(xs: number[]) {\n" +
				"\tfor (let i = 0; i < xs.length; i++) void i;\n" +
				"\tfor (const k in xs) void k;\n" +
				"\tfor (const x of xs) void x;\n" +
				"\twhile (xs.length > 0) break;\n" +
				"\tdo { break; } while (xs.length > 0);\n" +
				"}\n",
		);
		expect(result).toEqual({ name: "f", cc: 6, maxNesting: 1 });
	});

	test("counts case clauses but not the default clause", () => {
		// Two cases → CC 3; case bodies sit one level under the switch.
		const result = measureOne(
			"function f(x: number) {\n" +
				"\tswitch (x) {\n" +
				"\t\tcase 1:\n" +
				"\t\t\treturn;\n" +
				"\t\tcase 2:\n" +
				"\t\t\treturn;\n" +
				"\t\tdefault:\n" +
				"\t\t\treturn;\n" +
				"\t}\n" +
				"}\n",
		);
		expect(result).toEqual({ name: "f", cc: 3, maxNesting: 1 });
	});

	test("counts catch but not finally, and keeps handlers at the try's level", () => {
		// One CatchClause → CC 2; try/catch/finally bodies all at depth 1.
		const result = measureOne(
			"function f() {\n" +
				"\ttry {\n" +
				"\t\twork();\n" +
				"\t} catch (e) {\n" +
				"\t\trecover(e);\n" +
				"\t} finally {\n" +
				"\t\tdone();\n" +
				"\t}\n" +
				"}\n",
		);
		expect(result).toEqual({ name: "f", cc: 2, maxNesting: 1 });
	});

	test("counts conditional expressions and logical operators per operator", () => {
		// ternary + (&& + ternary) + (?? + || + ||) = 6 decisions → CC 7; no nesting.
		const result = measureOne(
			"function f(a: number, b: number, c: number | null) {\n" +
				"\tconst t = a > 0 ? a : b;\n" +
				"\tconst u = a > 0 && b > 0 ? 1 : 0;\n" +
				"\tconst v = (c ?? 0) || t || u;\n" +
				"\treturn v;\n" +
				"}\n",
		);
		expect(result).toEqual({ name: "f", cc: 7, maxNesting: 0 });
	});

	test("counts each logical assignment operator once", () => {
		// &&=, ||=, ??= → 3 decisions → CC 4.
		const result = measureOne(
			"function f(a: number, b: number | null, c: number | null) {\n" +
				"\tlet x = a;\n" +
				"\tx &&= 1;\n" +
				"\tx ||= b ?? 0;\n" +
				"\tlet y = c;\n" +
				"\ty ??= 2;\n" +
				"\treturn x + y;\n" +
				"}\n",
		);
		// 3 logical assignments + 1 `??` binary = 4 decisions → CC 5.
		expect(result).toEqual({ name: "f", cc: 5, maxNesting: 0 });
	});

	test("counts each optional-chaining token once", () => {
		// a?.b (+1), ?.[0] (+1), ?? (+1) → CC 4.
		const result = measureOne(
			"interface Row { b?: number[] }\n" +
				"function f(a: Row | null) {\n" +
				"\treturn a?.b?.[0] ?? 0;\n" +
				"}\n",
		);
		expect(result).toEqual({ name: "f", cc: 4, maxNesting: 0 });
	});

	test("counts an optional call's question-dot", () => {
		// g?.() (+1) and ?? (+1) → CC 3.
		const result = measureOne(
			"function f(g?: () => number) {\n" + "\treturn g?.() ?? 0;\n" + "}\n",
		);
		expect(result).toEqual({ name: "f", cc: 3, maxNesting: 0 });
	});

	test("ignores non-null assertions and optional type markers", () => {
		// `x!` and `a?: number` are not decisions; only `??` counts → CC 2.
		const result = measureOne(
			"interface Bag { a?: number }\n" +
				"function f(x: Bag | null) {\n" +
				"\tconst y = x!.a ?? 0;\n" +
				"\treturn y;\n" +
				"}\n",
		);
		expect(result).toEqual({ name: "f", cc: 2, maxNesting: 0 });
	});

	test("attributes nested function decisions to the nested function alone", () => {
		// Outer: one if → CC 2, nesting 1. Inner arrow: if + ternary → CC 3,
		// nesting 1 (its own depth starts at 0).
		const results = measure(
			"function outer(a: number) {\n" +
				"\tif (a > 0) {\n" +
				"\t\tlog(a);\n" +
				"\t}\n" +
				"\tconst inner = (b: number) => {\n" +
				"\t\tif (b > 0) {\n" +
				"\t\t\treturn b;\n" +
				"\t\t}\n" +
				"\t\treturn b > -1 ? 0 : -1;\n" +
				"\t};\n" +
				"\treturn inner(a);\n" +
				"}\n",
		);
		expect(results).toEqual([
			{ name: "outer", cc: 2, maxNesting: 1 },
			{ name: "inner", cc: 3, maxNesting: 1 },
		]);
	});

	test("measures expression-bodied arrows", () => {
		const result = measureOne("const f = (a: number) => (a > 0 ? a : 0);\n");
		expect(result).toEqual({ name: "f", cc: 2, maxNesting: 0 });
	});

	test("stacks nesting across control structures", () => {
		// for > if > while → step() sits at depth 3.
		const result = measureOne(
			"function f(x: boolean, y: boolean) {\n" +
				"\tfor (;;) {\n" +
				"\t\tif (x) {\n" +
				"\t\t\twhile (y) {\n" +
				"\t\t\t\tstep();\n" +
				"\t\t\t\tbreak;\n" +
				"\t\t\t}\n" +
				"\t\t}\n" +
				"\t\tbreak;\n" +
				"\t}\n" +
				"}\n",
		);
		expect(result).toEqual({ name: "f", cc: 4, maxNesting: 3 });
	});

	test("counts an if inside a switch case one level under the switch", () => {
		// case (+1) + if (+1) → CC 3; the if's body is under switch + if → depth 2.
		const result = measureOne(
			"function f(x: number) {\n" +
				"\tswitch (x) {\n" +
				"\t\tcase 1: {\n" +
				"\t\t\tif (x > 0) {\n" +
				"\t\t\t\thit();\n" +
				"\t\t\t}\n" +
				"\t\t\tbreak;\n" +
				"\t\t}\n" +
				"\t\tdefault:\n" +
				"\t\t\tbreak;\n" +
				"\t}\n" +
				"}\n",
		);
		expect(result).toEqual({ name: "f", cc: 3, maxNesting: 2 });
	});
});
