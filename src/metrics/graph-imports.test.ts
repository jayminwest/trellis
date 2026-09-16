import { describe, expect, test } from "bun:test";
import { parseSource } from "../syntax/index.ts";
import { collectImportSites } from "./graph-imports.ts";

/** Extract the import sites of `text` (parsed as `src/a.ts`). */
function sites(text: string) {
	return collectImportSites(parseSource("src/a.ts", text).sourceFile);
}

/** Project sites to their comparable shape. */
function project(text: string) {
	return sites(text).map((site) => ({
		kind: site.kind,
		typeOnly: site.typeOnly,
		specifier: site.specifier,
		line: site.range.start.line,
	}));
}

describe("collectImportSites statement forms", () => {
	test("captures static imports as runtime edges in source order", () => {
		expect(
			project(
				'import def from "./a";\n' +
					'import { named } from "./b";\n' +
					'import * as ns from "./c";\n' +
					'import "./side-effect";\n',
			),
		).toEqual([
			{ kind: "import", typeOnly: false, specifier: "./a", line: 1 },
			{ kind: "import", typeOnly: false, specifier: "./b", line: 2 },
			{ kind: "import", typeOnly: false, specifier: "./c", line: 3 },
			{ kind: "import", typeOnly: false, specifier: "./side-effect", line: 4 },
		]);
	});

	test("`import type` keeps its type-only identity; per-specifier `type` modifiers do not flip the edge", () => {
		expect(project('import type { T } from "./t";\nimport { type U, v } from "./v";\n')).toEqual([
			{ kind: "import", typeOnly: true, specifier: "./t", line: 1 },
			{ kind: "import", typeOnly: false, specifier: "./v", line: 2 },
		]);
	});

	test("captures re-export forms with their kind and type-only identity", () => {
		expect(
			project(
				'export { a } from "./a";\n' +
					'export * from "./b";\n' +
					'export * as ns from "./c";\n' +
					'export type { T } from "./t";\n',
			),
		).toEqual([
			{ kind: "re-export", typeOnly: false, specifier: "./a", line: 1 },
			{ kind: "re-export", typeOnly: false, specifier: "./b", line: 2 },
			{ kind: "re-export", typeOnly: false, specifier: "./c", line: 3 },
			{ kind: "re-export", typeOnly: true, specifier: "./t", line: 4 },
		]);
	});

	test("captures TS import-equals require as an import edge", () => {
		expect(project('import legacy = require("./legacy");\n')).toEqual([
			{ kind: "import", typeOnly: false, specifier: "./legacy", line: 1 },
		]);
	});

	test("an `export { … }` without a module specifier is not an edge", () => {
		const local = "const x = 1;\nexport { x };\n";
		expect(sites(local)).toEqual([]);
	});
});

describe("collectImportSites dynamic and type-position imports", () => {
	test("captures literal dynamic imports as dynamic edges", () => {
		expect(project('const lazy = () => import("./lazy");\n')).toEqual([
			{ kind: "dynamic", typeOnly: false, specifier: "./lazy", line: 1 },
		]);
	});

	test("a non-literal dynamic import records a null specifier", () => {
		const [site] = sites("declare const name: string;\nconst lazy = () => import(name);\n");
		expect(site?.kind).toBe("dynamic");
		expect(site?.specifier).toBeNull();
		expect(site?.range.start.line).toBe(2);
	});

	test("captures type-position import types as type-only import edges", () => {
		expect(project('type T = import("./t").T;\ntype U = typeof import("./u");\n')).toEqual([
			{ kind: "import", typeOnly: true, specifier: "./t", line: 1 },
			{ kind: "import", typeOnly: true, specifier: "./u", line: 2 },
		]);
	});

	test("orders nested dynamic sites with statement sites by position", () => {
		expect(project('import "./a";\nexport const f = () => import("./b");\n')).toEqual([
			{ kind: "import", typeOnly: false, specifier: "./a", line: 1 },
			{ kind: "dynamic", typeOnly: false, specifier: "./b", line: 2 },
		]);
	});
});

describe("collectImportSites forgery resistance (SPEC §5.4)", () => {
	test("comments cannot forge imports", () => {
		expect(
			sites(
				'// import { a } from "./fake-a";\n' +
					'/* export * from "./fake-b"; */\n' +
					'/*\n * import("./fake-c");\n */\n' +
					"export const real = 1;\n",
			),
		).toEqual([]);
	});

	test("string and template contents cannot forge imports", () => {
		expect(
			sites(
				"const a = \"import x from './fake-a'\";\n" +
					'const b = `export * from "./fake-b"`;\n' +
					"const c = 'import(\"./fake-c\")';\n",
			),
		).toEqual([]);
	});

	test("JSDoc import types cannot forge imports", () => {
		expect(sites('/** @type {import("./fake").T} */\nexport const x = 1;\n')).toEqual([]);
	});

	test("only the real specifier of a mixed line is captured", () => {
		const [site] = sites('import "./real"; // import "./fake";\n');
		expect(site?.specifier).toBe("./real");
		expect(site?.range).toEqual({ start: { line: 1, column: 9 }, end: { line: 1, column: 15 } });
	});
});
