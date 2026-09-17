import { describe, expect, test } from "bun:test";
import { parseSource } from "./parse.ts";
import { countLines } from "./sloc.ts";

/** Line counts for `text` parsed with the given file name (extension drives the variant). */
function linesOf(text: string, path = "a.ts") {
	return countLines(parseSource(path, text).sourceFile);
}

describe("countLines basic classification", () => {
	test("splits code, comment-only and blank lines and always sums to total", () => {
		const counts = linesOf(
			[
				"// header", // commentOnly
				"", // blank
				"const a = 1; // tail", // code
				"   ", // blank (whitespace only)
				"export { a };", // code
			].join("\n"),
		);
		expect(counts).toEqual({ total: 5, code: 2, commentOnly: 1, blank: 2 });
	});

	test("counts a trailing newline as a final blank line", () => {
		expect(linesOf("const a = 1;\n")).toEqual({ total: 2, code: 1, commentOnly: 0, blank: 1 });
	});

	test("classifies an empty file as one blank line", () => {
		expect(linesOf("")).toEqual({ total: 1, code: 0, commentOnly: 0, blank: 1 });
	});
});

describe("countLines documented multiline handling", () => {
	test("counts every line of a multiline template literal as code", () => {
		const counts = linesOf(["const sql = `", "\tSELECT *", "\tFROM t", "`;", ""].join("\n"));
		expect(counts).toEqual({ total: 5, code: 4, commentOnly: 0, blank: 1 });
	});

	test("counts interior lines of a block comment as comment-only", () => {
		const counts = linesOf(
			["/*", " * explanation", " */", "const a = 1;", "/* one-liner */", ""].join("\n"),
		);
		expect(counts).toEqual({ total: 6, code: 1, commentOnly: 4, blank: 1 });
	});

	test("keeps comment-looking text inside strings as code", () => {
		const counts = linesOf('const s = "// not a comment";\nconst t = "/* nor this */";\n');
		expect(counts.code).toBe(2);
		expect(counts.commentOnly).toBe(0);
	});

	test("keeps code-looking text inside comments as comments", () => {
		const counts = linesOf("// const a = 1;\n/* if (x) { y(); } */\n");
		expect(counts.code).toBe(0);
		expect(counts.commentOnly).toBe(2);
	});

	test("counts a line with both code and a trailing comment as code", () => {
		const counts = linesOf("const a = 1; /* tail */\n");
		expect(counts).toEqual({ total: 2, code: 1, commentOnly: 0, blank: 1 });
	});
});

describe("countLines variants", () => {
	test("scans TSX with the JSX language variant", () => {
		const counts = linesOf(
			["export const V = () => (", "\t<div>hi</div>", ");", ""].join("\n"),
			"view.tsx",
		);
		expect(counts).toEqual({ total: 4, code: 3, commentOnly: 0, blank: 1 });
	});

	test("reuses the shared parse's line map, so positions agree with ranges", () => {
		const text = "// c\nfunction f() {}\n";
		const parsed = parseSource("a.ts", text);
		const counts = countLines(parsed.sourceFile);
		expect(counts.total).toBe(parsed.sourceFile.getLineStarts().length);
		expect(counts.code).toBe(1);
	});
});
