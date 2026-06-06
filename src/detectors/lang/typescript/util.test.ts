import { describe, expect, test } from "bun:test";
import type { DetectionContext } from "../../types.ts";
import { biomeLinterEnabled, biomeRuleLevel, loadTsConfig, parseJsonc, tsSources } from "./util.ts";

function memCtx(files: Record<string, string>): DetectionContext {
	const keys = Object.keys(files).sort();
	return {
		repoPath: "/mem",
		app: { path: ".", languages: ["typescript"] },
		run: async () => ({ exitCode: 127, stdout: "", stderr: "", timedOut: false }),
		readFile: async (rel) => files[rel] ?? files[rel.replace(/^\.\//, "")] ?? null,
		glob: async (pattern) => {
			const ext = pattern.endsWith(".tsx") ? ".tsx" : ".ts";
			return keys.filter((k) => k.endsWith(ext));
		},
	};
}

describe("parseJsonc", () => {
	test("strips line and block comments and trailing commas", () => {
		const text = `{
			// a leading comment
			"a": 1, /* inline */
			"b": [2, 3,],
		}`;
		expect(parseJsonc(text)).toEqual({ a: 1, b: [2, 3] });
	});

	test("returns null for non-object or invalid JSON", () => {
		expect(parseJsonc("not json")).toBeNull();
		expect(parseJsonc("[1,2,3]")).toBeNull();
	});

	test("does not strip `//` inside string values", () => {
		expect(parseJsonc('{"url":"https://example.com"}')).toEqual({ url: "https://example.com" });
	});
});

describe("loadTsConfig", () => {
	test("merges a multi-level extends chain (base → child)", async () => {
		const ctx = memCtx({
			"tsconfig.json": '{"extends":"./mid.json","compilerOptions":{"strict":true}}',
			"mid.json": '{"extends":"./base.json","compilerOptions":{"noUnusedLocals":true}}',
			"base.json": '{"compilerOptions":{"target":"ES2022","strict":false}}',
		});
		const resolved = await loadTsConfig(ctx);
		expect(resolved?.compilerOptions.strict).toBe(true); // child wins
		expect(resolved?.compilerOptions.noUnusedLocals).toBe(true);
		expect(resolved?.compilerOptions.target).toBe("ES2022");
		expect(resolved?.extendsUnresolved).toBe(false);
	});

	test("flags an unresolved package extends", async () => {
		const resolved = await loadTsConfig(
			memCtx({ "tsconfig.json": '{"extends":"@tsconfig/strictest"}' }),
		);
		expect(resolved?.extendsUnresolved).toBe(true);
	});

	test("returns null when absent", async () => {
		expect(await loadTsConfig(memCtx({}))).toBeNull();
	});
});

describe("biome helpers", () => {
	test("biomeRuleLevel reads string and object rule forms", () => {
		const cfg = parseJsonc(
			'{"linter":{"rules":{"suspicious":{"noExplicitAny":"error"},"complexity":{"x":{"level":"warn"}}}}}',
		);
		expect(cfg).not.toBeNull();
		if (cfg !== null) {
			expect(biomeRuleLevel(cfg, "suspicious", "noExplicitAny")).toBe("error");
			expect(biomeRuleLevel(cfg, "complexity", "x")).toBe("warn");
			expect(biomeRuleLevel(cfg, "style", "missing")).toBeNull();
		}
	});

	test("biomeLinterEnabled defaults to enabled unless explicitly false", () => {
		expect(biomeLinterEnabled({ linter: {} })).toBe(true);
		expect(biomeLinterEnabled({ linter: { enabled: false } })).toBe(false);
		expect(biomeLinterEnabled({})).toBe(false);
	});
});

describe("tsSources", () => {
	test("excludes vendored/build dirs and .d.ts files", async () => {
		const ctx = memCtx({
			"src/a.ts": "x",
			"src/b.tsx": "x",
			"src/types.d.ts": "x",
			"node_modules/pkg/index.ts": "x",
			"dist/a.ts": "x",
		});
		expect(await tsSources(ctx)).toEqual(["src/a.ts", "src/b.tsx"]);
	});
});
