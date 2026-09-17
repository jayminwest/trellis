import { describe, expect, test } from "bun:test";
import { parseSource, positionAt, rangeAt, scriptVariantForPath } from "./parse.ts";

describe("scriptVariantForPath", () => {
	test("maps .tsx to the TSX variant and every other TS extension to TS", () => {
		expect(scriptVariantForPath("src/view.tsx")).toBe("tsx");
		expect(scriptVariantForPath("src/index.ts")).toBe("ts");
		expect(scriptVariantForPath("src/mod.mts")).toBe("ts");
		expect(scriptVariantForPath("src/mod.cts")).toBe("ts");
		expect(scriptVariantForPath("types.d.ts")).toBe("ts");
	});
});

describe("parseSource", () => {
	test("parses TS and TSX with the matching script kind and no diagnostics", () => {
		const ts = parseSource("src/index.ts", "export const x: number = 1;\n");
		expect(ts.scriptKind).toBe("ts");
		expect(ts.sourceFile.statements).toHaveLength(1);
		expect(ts.diagnostics).toEqual([]);

		const tsx = parseSource("src/view.tsx", "export const V = () => <div>hi</div>;\n");
		expect(tsx.scriptKind).toBe("tsx");
		expect(tsx.diagnostics).toEqual([]);
	});

	test("sets parent pointers so analyzers can walk upward", () => {
		const { sourceFile } = parseSource("a.ts", "function f() { return 1; }\n");
		const statement = sourceFile.statements[0];
		expect(statement?.parent.kind).toBe(sourceFile.kind);
	});

	test("surfaces syntax errors as located diagnostics instead of throwing", () => {
		const { sourceFile, diagnostics } = parseSource("src/broken.ts", "const x = ;\n");
		expect(diagnostics).toHaveLength(1);
		const [diagnostic] = diagnostics;
		expect(diagnostic?.path).toBe("src/broken.ts");
		expect(diagnostic?.code).toBe("TS1109");
		expect(diagnostic?.range.start).toEqual({ line: 1, column: 11 });
		// The parser recovers: a (partial) tree is still available for analysis.
		expect(sourceFile.statements.length).toBeGreaterThan(0);
	});

	test("locates later-line errors with 1-based positions", () => {
		const { diagnostics } = parseSource("b.ts", "const ok = 1;\n\nif (\n");
		expect(diagnostics.length).toBeGreaterThan(0);
		expect(diagnostics[0]?.range.start.line).toBe(3);
	});
});

describe("positionAt / rangeAt", () => {
	test("maps offsets to 1-based line and column", () => {
		const { sourceFile } = parseSource("a.ts", "const a = 1;\n\nfunction f() {\n\treturn a;\n}\n");
		expect(positionAt(sourceFile, 0)).toEqual({ line: 1, column: 1 });
		// "function" starts at offset 14 → line 3, column 1.
		expect(positionAt(sourceFile, 14)).toEqual({ line: 3, column: 1 });
		// "return" starts at offset 30 (after the tab) → line 4, column 2.
		expect(positionAt(sourceFile, 30)).toEqual({ line: 4, column: 2 });
	});

	test("builds a half-open range from two offsets", () => {
		const { sourceFile } = parseSource("a.ts", "const a = 1;\nconst b = 2;\n");
		expect(rangeAt(sourceFile, 0, 11)).toEqual({
			start: { line: 1, column: 1 },
			end: { line: 1, column: 12 },
		});
	});
});
