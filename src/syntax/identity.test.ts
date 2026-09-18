import { describe, expect, test } from "bun:test";
import { collectFunctions } from "./functions.ts";
import type { FunctionIdentity } from "./identity.ts";
import { parseSource } from "./parse.ts";

function identities(text: string): FunctionIdentity[] {
	return collectFunctions(parseSource("a.ts", text).sourceFile).functions.map((fn) => fn.identity);
}

function identified(text: string, index = 0) {
	const identity = identities(text)[index];
	if (identity?.state !== "identified")
		throw new Error(`expected identified: ${JSON.stringify(identity)}`);
	return identity;
}

describe("collectFunctionIdentities", () => {
	test("retains identity across comments, body edits, sibling insertion and reordering", () => {
		const original = identified("function alpha() { return 1; }");
		for (const text of [
			"// shifted\n\nfunction alpha() { return 1; }",
			"function alpha() { if (yes) return 2; return 3; } function beta() {}",
		])
			expect(identified(text)).toEqual(original);
		expect(identified("function beta() {} function alpha() {}", 1)).toEqual(original);
		expect(identified("function beta() {} ")).not.toEqual(original);
	});

	test("distinguishes class ancestry, static members, accessors and constructors", () => {
		const result = identities(`class A {
			constructor() {}
			run() {}
			static run() {}
			get value() { return 1; }
			set value(v) {}
			#run() {}
		}
		class B { run() {} }`);
		expect(result).toHaveLength(7);
		expect(new Set(result.map((identity) => JSON.stringify(identity))).size).toBe(7);
		for (const identity of result) expect(identity.state).toBe("identified");
		expect(identified("class A { static run() {} }").function.member).toBe("static");
		expect(identified("class A { get x() { return 1; } }").function.kind).toBe("get-accessor");
		expect(identified("class A { #run() {} }").function.name).toBe("#run");
		expect(identified("class A { constructor() {} }").function.kind).toBe("constructor");
	});

	test("uses binding names separately from display names and enclosing scopes", () => {
		const fn = collectFunctions(
			parseSource("a.ts", "const bound = function inner() {}; ").sourceFile,
		).functions[0];
		expect(fn?.name).toBe("inner");
		expect(identified("const bound = function inner() {}; ").function.name).toBe("bound");
		const nested = identities(
			"function outer() { const object = { run() { function inner() {} } }; }",
		);
		const inner = nested[2];
		expect(inner?.state).toBe("identified");
		if (inner?.state !== "identified") throw new Error("missing inner");
		expect(inner.scopes.map(({ kind, name }) => [kind, name])).toEqual([
			["function-declaration", "outer"],
			["object", "object"],
			["method", "run"],
		]);
		expect(identified("const a = { run() {} };")).not.toEqual(
			identified("const b = { run() {} };"),
		);
	});

	test("recognizes contextual class fields, nested objects, class expressions and namespaces", () => {
		for (const text of [
			"const callback = () => 1;",
			"const o = { handler: () => 1 };",
			"class A { handler = () => 1; }",
			"const o = { nested: { run() {} } };",
			"const A = class { run() {} };",
			"const o = { A: class { run() {} } };",
			"namespace N { export function run() {} }",
			"const o = { 'run'() {} };",
		])
			expect(identified(text).state).toBe("identified");
		expect(identified("class A { static handler = () => 1; }").function.member).toBe("static");
		expect(identified("class A { handler = () => 1; }").function.member).toBe("instance");
	});

	test("excludes overloads without adding identity collisions", () => {
		const text =
			"function a(x: string): void; function a(x: number): void; function a(x: unknown) {}";
		expect(identities(text)).toHaveLength(1);
		expect(identified(text)).toEqual(identified("function a() {}"));
		expect(
			identities("declare function ambient(): void; abstract class A { abstract run(): void; }"),
		).toEqual([]);
	});

	const ambiguousCases = [
		["list.map(() => 1)", "anonymous"],
		["list.map(function named() {})", "anonymous"],
		["export default function () {}", "anonymous"],
		["const a = (() => 1)", "anonymous"],
		["a = () => 1", "anonymous"],
		["const {a} = () => 1", "anonymous"],
		["const [a] = () => 1", "anonymous"],
		["class A { [key]() {} }", "computed-name"],
		["const o = { ['run']: () => 1 }", "computed-name"],
		["const o = { [key]: { run() {} } }", "computed-name"],
		["call({ run() {} })", "unnamed-scope"],
		["export default class { run() {} }", "unnamed-scope"],
		["{ function a() {} }", "block-scope"],
		["function outer() { { function a() {} } }", "block-scope"],
		["for (const a of items) function run() {}", "block-scope"],
		["try {} catch (error) { function run() {} }", "block-scope"],
		["switch (x) { case 1: function run() {} }", "block-scope"],
		["class A { static { function run() {} } }", "block-scope"],
		["call(() => { function inner() {} })", "anonymous"],
	] as const;
	for (const [text, reason] of ambiguousCases) {
		test(`marks ${reason} in ${text}`, () => {
			expect(identities(text).at(-1)).toEqual({ version: "1.0.0", state: "ambiguous", reason });
		});
	}

	test("preserves colliding functions and propagates duplicate containers to all descendants", () => {
		for (const text of [
			"function a() {} function a() {} function a() {}",
			"class A { a() {} } class A { b() {} }",
			"const a = { run() {} }; const a = { other() {} };",
			"function a() { function x() {} } function a() { function y() {} }",
			"namespace N { function a() {} } namespace N { function b() {} }",
		]) {
			const result = identities(text);
			expect(result.length).toBeGreaterThan(1);
			for (const identity of result) {
				expect(identity).toEqual({ version: "1.0.0", state: "ambiguous", reason: "duplicate" });
			}
		}
	});
});
