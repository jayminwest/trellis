import { describe, expect, test } from "bun:test";
import {
	accountCloneLines,
	InvalidJscpdEvidenceError,
	type JscpdAccountedFile,
	type JscpdCloneMemberSpan,
} from "./lines.ts";

/** A small accounted file: two leading comment lines, one blank, four code lines. */
const MIXED_TEXT = [
	"// leading note", // commentOnly
	"/* block", // commentOnly
	"   still comment */", // commentOnly
	"", // blank
	"export function total(items: number[]): number {", // code
	" let subtotal = 0;", // code
	" return subtotal + items.length;", // code
	"}", // code
].join("\n");

/** A file whose covered span is one multiline template literal plus its bookends. */
const TEMPLATE_TEXT = ["export const banner = `", "first line", "second line", "`;"].join("\n");

function productionFile(path: string, text: string): JscpdAccountedFile {
	return { path, sourceSet: "production", text };
}

function testFile(path: string, text: string): JscpdAccountedFile {
	return { path, sourceSet: "test", text };
}

function span(path: string, startLine: number, endLine: number): JscpdCloneMemberSpan {
	return { path, startLine, endLine };
}

describe("accountCloneLines", () => {
	test("counts covered code-classified lines and skips comment-only and blank lines", () => {
		const accounts = accountCloneLines([productionFile("a.ts", MIXED_TEXT)], [span("a.ts", 1, 8)]);
		expect(accounts.production).toEqual({
			files: 1,
			codeLines: 4,
			affectedCodeLines: 4,
		});
		expect(accounts.test).toEqual({ files: 0, codeLines: 0, affectedCodeLines: 0 });
	});

	test("unions overlapping member spans within one file so no line counts twice", () => {
		const text = `${"export const a = 1;\n".repeat(20)}`;
		const accounts = accountCloneLines(
			[productionFile("a.ts", text)],
			[span("a.ts", 1, 10), span("a.ts", 5, 14), span("a.ts", 20, 20)],
		);
		expect(accounts.production.affectedCodeLines).toBe(15);
		expect(accounts.production.codeLines).toBe(20);
	});

	test("counts every line of a multiline literal as code", () => {
		const accounts = accountCloneLines(
			[productionFile("a.ts", TEMPLATE_TEXT)],
			[span("a.ts", 1, 4)],
		);
		expect(accounts.production).toEqual({ files: 1, codeLines: 4, affectedCodeLines: 4 });
	});

	test("separates production and test accounts and splits cross-set clone members", () => {
		const accounts = accountCloneLines(
			[productionFile("src/a.ts", MIXED_TEXT), testFile("src/a.test.ts", MIXED_TEXT)],
			[span("src/a.ts", 5, 8), span("src/a.test.ts", 5, 8)],
		);
		expect(accounts.production).toEqual({ files: 1, codeLines: 4, affectedCodeLines: 4 });
		expect(accounts.test).toEqual({ files: 1, codeLines: 4, affectedCodeLines: 4 });
	});

	test("clamps member spans to the file's line count", () => {
		const accounts = accountCloneLines(
			[productionFile("a.ts", "export const one = 1;\nexport const two = 2;\n")],
			[span("a.ts", 1, 99)],
		);
		expect(accounts.production).toEqual({ files: 1, codeLines: 2, affectedCodeLines: 2 });
	});

	test("reports zero affected lines when no clone member is passed", () => {
		const accounts = accountCloneLines([productionFile("a.ts", MIXED_TEXT)], []);
		expect(accounts.production).toEqual({ files: 1, codeLines: 4, affectedCodeLines: 0 });
	});

	test("rejects clone members that reference files outside the accounted selection", () => {
		expect(() =>
			accountCloneLines([productionFile("a.ts", MIXED_TEXT)], [span("b.ts", 1, 4)]),
		).toThrow(/not an accounted file/);
	});

	test("rejects an accounted file listed more than once", () => {
		expect(() =>
			accountCloneLines(
				[productionFile("a.ts", MIXED_TEXT), productionFile("a.ts", MIXED_TEXT)],
				[],
			),
		).toThrow(/listed more than once/);
	});

	test("rejects member spans that end before they start", () => {
		expect(() =>
			accountCloneLines([productionFile("a.ts", MIXED_TEXT)], [span("a.ts", 8, 4)]),
		).toThrow(/ends \(4\) before it starts \(8\)/);
	});

	test("rejects accounted files outside the measured production/test sets", () => {
		const generated: JscpdAccountedFile = {
			...productionFile("gen/a.ts", MIXED_TEXT),
			sourceSet: "generated" as JscpdAccountedFile["sourceSet"],
		};
		expect(() => accountCloneLines([generated], [])).toThrow(InvalidJscpdEvidenceError);
		expect(() => accountCloneLines([generated], [])).toThrow(/measured production\/test sets only/);
	});
});
