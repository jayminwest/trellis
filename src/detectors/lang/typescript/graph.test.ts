import { describe, expect, test } from "bun:test";
import type { DetectionContext } from "../../types.ts";
import {
	buildImportGraph,
	findCycle,
	relativeSpecifiers,
	resolveRelative,
	stripComments,
} from "./graph.ts";

/** In-memory context over a `{ path: contents }` map — no temp fs needed for graph logic. */
function memCtx(files: Record<string, string>): DetectionContext {
	const keys = Object.keys(files).sort();
	return {
		repoPath: "/mem",
		app: { path: ".", languages: ["typescript"] },
		run: async () => ({ exitCode: 127, stdout: "", stderr: "", timedOut: false }),
		readFile: async (rel) => files[rel] ?? null,
		glob: async (pattern) => {
			const ext = pattern.endsWith(".tsx") ? ".tsx" : ".ts";
			return keys.filter((k) => k.endsWith(ext));
		},
	};
}

describe("relativeSpecifiers", () => {
	test("extracts static, re-export, bare, and dynamic relative specifiers", () => {
		const text = [
			'import { a } from "./a.ts";',
			'export { b } from "../b.ts";',
			'import "./side-effect.ts";',
			'const m = await import("./dyn.ts");',
			'import { x } from "node:path";',
			'import pkg from "some-package";',
		].join("\n");
		expect(relativeSpecifiers(text)).toEqual(["./a.ts", "../b.ts", "./side-effect.ts", "./dyn.ts"]);
	});

	test("ignores import()-shaped doc-links and commented-out imports", () => {
		const text = [
			'/** See {@link import("../registry.ts")} for the bindings. */',
			'// import { stale } from "./old.ts";',
			'import { real } from "./real.ts";',
		].join("\n");
		expect(relativeSpecifiers(text)).toEqual(["./real.ts"]);
	});
});

describe("stripComments", () => {
	test("blanks line and block comments while preserving string literals", () => {
		const text = 'const u = "https://x/a"; // import("./c.ts")\n/* import("./d.ts") */';
		const stripped = stripComments(text);
		expect(stripped).toContain('"https://x/a"');
		expect(stripped).not.toContain("./c.ts");
		expect(stripped).not.toContain("./d.ts");
	});

	test("does not treat // inside a string literal as a comment", () => {
		const text = 'import { real } from "./real.ts"; const g = "a//b";';
		expect(relativeSpecifiers(text)).toEqual(["./real.ts"]);
		expect(stripComments(text)).toContain('"a//b"');
	});
});

describe("resolveRelative", () => {
	const set = new Set(["src/a.ts", "src/dir/index.ts", "src/b.tsx"]);
	test("resolves an explicit .ts specifier", () => {
		expect(resolveRelative("src/main.ts", "./a.ts", set)).toBe("src/a.ts");
	});
	test("resolves an extensionless specifier via suffix probing", () => {
		expect(resolveRelative("src/main.ts", "./a", set)).toBe("src/a.ts");
	});
	test("resolves a directory specifier to its index", () => {
		expect(resolveRelative("src/main.ts", "./dir", set)).toBe("src/dir/index.ts");
	});
	test("returns null for an unresolvable specifier", () => {
		expect(resolveRelative("src/main.ts", "./nope", set)).toBeNull();
	});
});

describe("buildImportGraph + findCycle", () => {
	test("an acyclic graph yields no cycle", async () => {
		const graph = await buildImportGraph(
			memCtx({
				"a.ts": 'import { b } from "./b.ts";',
				"b.ts": 'import { c } from "./c.ts";',
				"c.ts": "export const c = 1;",
			}),
		);
		expect(graph.size).toBe(3);
		expect(findCycle(graph)).toBeNull();
	});

	test("detects a two-node import cycle", async () => {
		const graph = await buildImportGraph(
			memCtx({
				"a.ts": 'import { b } from "./b.ts";',
				"b.ts": 'import { a } from "./a.ts";',
			}),
		);
		const cycle = findCycle(graph);
		expect(cycle).not.toBeNull();
		expect(cycle?.[0]).toBe(cycle?.[cycle.length - 1]);
	});

	test("detects a three-node cycle", async () => {
		const graph = await buildImportGraph(
			memCtx({
				"a.ts": 'import "./b.ts";',
				"b.ts": 'import "./c.ts";',
				"c.ts": 'import "./a.ts";',
			}),
		);
		expect(findCycle(graph)).not.toBeNull();
	});
});
