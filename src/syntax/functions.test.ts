import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { collectFunctions, walkOwnNodes } from "./functions.ts";
import { parseSource } from "./parse.ts";
import type { FunctionFacts } from "./types.ts";

/** Inventory `text` (parsed as `a.ts`) and return the function facts. */
function inventoryOf(text: string): { functions: FunctionFacts[]; signatureCount: number } {
	return collectFunctions(parseSource("a.ts", text).sourceFile);
}

/** Compact `[kind, name]` projection for readable assertions. */
function kindsAndNames(functions: FunctionFacts[]): string[] {
	return functions.map((fn) => `${fn.kind}:${fn.name}`);
}

describe("collectFunctions kinds", () => {
	test("inventories declarations, expressions, arrows, methods, constructors and accessors", () => {
		const { functions, signatureCount } = inventoryOf(
			[
				"export function declared(a: number) { return a; }",
				"const arrow = (x: number) => x * 2;",
				"const namedExpr = function inner() { return 1; };",
				"class Greeter {",
				"\tconstructor(private name: string) {}",
				"\tget display(): string { return this.name; }",
				"\tset display(v: string) { this.name = v; }",
				"\tgreet(): string { return 'hi ' + this.name; }",
				"}",
				"",
			].join("\n"),
		);
		expect(kindsAndNames(functions)).toEqual([
			"function-declaration:declared",
			"arrow-function:arrow",
			"function-expression:inner",
			"constructor:constructor",
			"get-accessor:display",
			"set-accessor:display",
			"method:greet",
		]);
		expect(signatureCount).toBe(0);
		expect(functions.every((fn) => fn.depth === 0 && fn.parentIndex === null)).toBe(true);
	});

	test("inventories object-literal methods and accessors with property names", () => {
		const { functions } = inventoryOf(
			"const o = { run() { return 1; }, get v() { return 2; }, set v(x: number) {} };\n",
		);
		expect(kindsAndNames(functions)).toEqual(["method:run", "get-accessor:v", "set-accessor:v"]);
	});
});

describe("collectFunctions naming rule", () => {
	test("names anonymous callbacks from context or marks them anonymous", () => {
		const { functions } = inventoryOf(
			[
				"const fromVar = function () { return 1; };",
				"const handler = () => 2;",
				"items.forEach(function () { touch(); });",
				'button.on("click", () => fire());',
				"export default function () { return 3; }",
				"",
			].join("\n"),
		);
		expect(kindsAndNames(functions)).toEqual([
			"function-expression:fromVar",
			"arrow-function:handler",
			"function-expression:(anonymous)",
			"arrow-function:(anonymous)",
			"function-declaration:(anonymous)",
		]);
		expect(functions.map((fn) => fn.nameOrigin)).toEqual([
			"contextual",
			"contextual",
			"anonymous",
			"anonymous",
			"anonymous",
		]);
	});
});

describe("collectFunctions overload rule", () => {
	test("never inventories signatures and attaches their count to the implementation", () => {
		const { functions, signatureCount } = inventoryOf(
			[
				"export function pick(value: string): string;",
				"export function pick(value: number): number;",
				"export function pick(value: unknown): unknown {",
				"\treturn value;",
				"}",
				"declare function ambient(x: number): void;",
				"",
			].join("\n"),
		);
		expect(kindsAndNames(functions)).toEqual(["function-declaration:pick"]);
		expect(functions[0]?.overloadSignatures).toBe(2);
		expect(signatureCount).toBe(3);
	});

	test("counts class member overloads per class, including abstract methods", () => {
		const { functions, signatureCount } = inventoryOf(
			[
				"abstract class Base {",
				"\tabstract run(): void;",
				"\trender(a: string): void;",
				"\trender(a: number): void;",
				"\trender(a: unknown): void {}",
				"}",
				"",
			].join("\n"),
		);
		expect(kindsAndNames(functions)).toEqual(["method:render"]);
		expect(functions[0]?.overloadSignatures).toBe(2);
		expect(signatureCount).toBe(3);
	});

	test("ignores interface members entirely — they are types, not implementations", () => {
		const { functions, signatureCount } = inventoryOf(
			"interface Shape {\n\tarea(): number;\n}\nclass C implements Shape {\n\tarea(): number { return 1; }\n}\n",
		);
		expect(kindsAndNames(functions)).toEqual(["method:area"]);
		expect(functions[0]?.overloadSignatures).toBe(0);
		expect(signatureCount).toBe(0);
	});
});

describe("collectFunctions nesting attribution", () => {
	test("attributes nested functions to their innermost enclosing function", () => {
		const { functions } = inventoryOf(
			[
				"function outer() {",
				"\tif (ready()) { warm(); }",
				"\tfunction inner() {",
				"\t\tif (cold()) { heat(); }",
				"\t}",
				"\treturn [1].map((n) => n + 1);",
				"}",
				"",
			].join("\n"),
		);
		expect(kindsAndNames(functions)).toEqual([
			"function-declaration:outer",
			"function-declaration:inner",
			"arrow-function:(anonymous)",
		]);
		expect(functions.map((fn) => fn.depth)).toEqual([0, 1, 1]);
		expect(functions[0]?.parentIndex).toBeNull();
		expect(functions[1]?.parentIndex).toBe(0);
		expect(functions[2]?.parentIndex).toBe(0);
	});
});

describe("walkOwnNodes", () => {
	test("keeps nested branches out of the parent's own subtree", () => {
		const { functions } = inventoryOf(
			[
				"function outer(a: boolean, b: boolean) {",
				"\tif (a) { one(); }",
				"\tfunction inner(c: boolean) {",
				"\t\tif (c) { two(); }",
				"\t}",
				"\twhile (b) { spin(); }",
				"}",
				"",
			].join("\n"),
		);
		const countOwn = (fn: FunctionFacts, kind: ts.SyntaxKind): number => {
			let count = 0;
			walkOwnNodes(fn, (node) => {
				if (node.kind === kind) count += 1;
			});
			return count;
		};
		const [outer, inner] = functions;
		expect(outer && countOwn(outer, ts.SyntaxKind.IfStatement)).toBe(1);
		expect(outer && countOwn(outer, ts.SyntaxKind.WhileStatement)).toBe(1);
		expect(inner && countOwn(inner, ts.SyntaxKind.IfStatement)).toBe(1);
	});

	test("yields a nested function once, as an opaque leaf", () => {
		const { functions } = inventoryOf(
			"function outer() {\n\tfunction inner() { return () => 1; }\n\treturn inner();\n}\n",
		);
		const outer = functions[0];
		const seen: string[] = [];
		if (outer) {
			walkOwnNodes(outer, (node) => {
				if (ts.isFunctionLike(node)) seen.push(ts.SyntaxKind[node.kind] ?? "?");
			});
		}
		// outer itself + inner as a leaf; inner's arrow is never reached.
		expect(seen).toEqual(["FunctionDeclaration", "FunctionDeclaration"]);
	});

	test("walks an expression-bodied arrow down to its expression", () => {
		const { functions } = inventoryOf("const double = (n: number) => n * 2;\n");
		const arrow = functions[0];
		const seen: string[] = [];
		if (arrow) walkOwnNodes(arrow, (node) => seen.push(ts.SyntaxKind[node.kind] ?? "?"));
		expect(seen).toContain("BinaryExpression");
	});
});

describe("collectFunctions ranges", () => {
	test("locates the whole node and the body with 1-based positions", () => {
		const { functions } = inventoryOf("const x = 1;\nfunction f(a: number) {\n\treturn a;\n}\n");
		const fn = functions[0];
		expect(fn?.range).toEqual({
			start: { line: 2, column: 1 },
			end: { line: 4, column: 2 },
		});
		expect(fn?.bodyRange).toEqual({
			start: { line: 2, column: 23 },
			end: { line: 4, column: 2 },
		});
	});

	test("binds every entry to the shared parse's SourceFile", () => {
		const parsed = parseSource("a.ts", "function f() { return () => 1; }\n");
		const { functions } = collectFunctions(parsed.sourceFile);
		expect(functions).toHaveLength(2);
		for (const fn of functions) expect(fn.node.getSourceFile()).toBe(parsed.sourceFile);
	});
});
