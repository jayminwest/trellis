import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSourceInventory } from "../discovery/index.ts";
import type { ImportSite } from "./graph-imports.ts";
import { createGraphResolver, type GraphResolver } from "./graph-resolve.ts";

let repo: string;

beforeEach(async () => {
	repo = await mkdtemp(join(tmpdir(), "trellis-graph-resolve-"));
});

afterEach(async () => {
	await rm(repo, { recursive: true, force: true });
});

/** Write `content` to `relPath` under the temp repo, creating parent dirs. */
async function put(relPath: string, content: string): Promise<void> {
	const abs = join(repo, relPath);
	await mkdir(join(abs, ".."), { recursive: true });
	await writeFile(abs, content);
}

/** Build the resolver over the current temp repo. */
async function resolver(): Promise<GraphResolver> {
	return createGraphResolver(await discoverSourceInventory(repo));
}

/** A minimal runtime import site for `specifier`. */
function site(specifier: string): ImportSite {
	return {
		kind: "import",
		typeOnly: false,
		specifier,
		range: { start: { line: 1 }, end: { line: 1 } },
	};
}

describe("createGraphResolver relative resolution", () => {
	test("resolves extensionless and extension-mapped specifiers to inventoried files", async () => {
		await put("src/a.ts", "");
		await put("src/b.ts", "");
		await put("src/c.mts", "");
		const r = await resolver();
		expect(r.resolve("src/a.ts", site("./b"))).toEqual({ status: "local", target: "src/b.ts" });
		// Extension mapping: a `.js`/`.mjs` specifier lands on the TS source.
		expect(r.resolve("src/a.ts", site("./b.js"))).toEqual({ status: "local", target: "src/b.ts" });
		expect(r.resolve("src/a.ts", site("./c.mjs"))).toEqual({
			status: "local",
			target: "src/c.mts",
		});
	});

	test("maps a directory specifier onto its barrel index", async () => {
		await put("src/a.ts", "");
		await put("src/sub/index.ts", "");
		const r = await resolver();
		expect(r.resolve("src/a.ts", site("./sub"))).toEqual({
			status: "local",
			target: "src/sub/index.ts",
		});
	});

	test("a relative specifier with no target is an unresolved local edge, never external", async () => {
		await put("src/a.ts", "");
		const r = await resolver();
		const resolution = r.resolve("src/a.ts", site("./missing"));
		expect(resolution.status).toBe("unresolved");
		expect(resolution).toMatchObject({ reason: "no-target" });
	});

	test("a file importing itself records a retained self-edge", async () => {
		await put("src/self.ts", "");
		const r = await resolver();
		expect(r.resolve("src/self.ts", site("./self"))).toEqual({
			status: "local",
			target: "src/self.ts",
		});
	});

	test("a specifier landing outside the classified scope is out-of-scope, not local", async () => {
		await put("src/a.ts", "");
		await put("dist/built.js", "console.log(1);\n");
		const r = await resolver();
		expect(r.resolve("src/a.ts", site("../dist/built.js"))).toEqual({
			status: "out-of-scope",
			target: "dist/built.js",
		});
	});
});

describe("createGraphResolver tsconfig aliases", () => {
	test("resolves paths aliases through the nearest governing tsconfig", async () => {
		await put(
			"tsconfig.json",
			JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/*"] } } }),
		);
		await put("src/main.ts", "");
		await put("src/util.ts", "");
		const r = await resolver();
		expect(r.resolve("src/main.ts", site("@app/util"))).toEqual({
			status: "local",
			target: "src/util.ts",
		});
		expect(r.configs()).toEqual([{ path: "tsconfig.json", status: "parsed" }]);
	});

	test("a matched alias with no target file is unresolved local intent, not external", async () => {
		await put(
			"tsconfig.json",
			JSON.stringify({ compilerOptions: { paths: { "@app/*": ["src/*"] } } }),
		);
		await put("src/main.ts", "");
		const r = await resolver();
		const resolution = r.resolve("src/main.ts", site("@app/missing"));
		expect(resolution.status).toBe("unresolved");
		expect(resolution).toMatchObject({ reason: "no-target" });
	});

	test("baseUrl alone resolves bare specifiers", async () => {
		await put("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: "src" } }));
		await put("src/main.ts", "");
		await put("src/lib/x.ts", "");
		const r = await resolver();
		expect(r.resolve("src/main.ts", site("lib/x"))).toEqual({
			status: "local",
			target: "src/lib/x.ts",
		});
	});

	test("a nested tsconfig governs only its own subtree", async () => {
		await put(
			"packages/a/tsconfig.json",
			JSON.stringify({ compilerOptions: { paths: { "~/*": ["./src/*"] } } }),
		);
		await put("packages/a/src/main.ts", "");
		await put("packages/a/src/inner.ts", "");
		await put("src/inner.ts", "");
		const r = await resolver();
		expect(r.resolve("packages/a/src/main.ts", site("~/inner"))).toEqual({
			status: "local",
			target: "packages/a/src/inner.ts",
		});
		// The root file has no governing alias: the same specifier is external there.
		expect(r.resolve("src/inner.ts", site("~/inner"))).toEqual({
			status: "external",
			packageName: "~",
		});
	});

	test("an unreadable tsconfig is recorded and contributes no aliases", async () => {
		await put("tsconfig.json", "{ not json");
		await put("src/main.ts", "");
		const r = await resolver();
		expect(r.resolve("src/main.ts", site("@app/util"))).toEqual({
			status: "external",
			packageName: "@app/util",
		});
		expect(r.configs()).toEqual([{ path: "tsconfig.json", status: "unreadable" }]);
	});
});

describe("createGraphResolver workspace packages", () => {
	beforeEach(async () => {
		await put("package.json", JSON.stringify({ name: "app", workspaces: ["packages/*"] }));
	});

	test("resolves a package name through its manifest exports map", async () => {
		await put(
			"packages/core/package.json",
			JSON.stringify({
				name: "@acme/core",
				exports: {
					".": "./src/index.ts",
					"./utils": { import: "./src/utils.ts", default: "./dist/utils.js" },
					"./feature/*": "./src/feature/*.ts",
				},
			}),
		);
		await put("packages/core/src/index.ts", "");
		await put("packages/core/src/utils.ts", "");
		await put("packages/core/src/feature/flags.ts", "");
		await put("src/app.ts", "");
		const r = await resolver();
		expect(r.resolve("src/app.ts", site("@acme/core"))).toEqual({
			status: "local",
			target: "packages/core/src/index.ts",
		});
		expect(r.resolve("src/app.ts", site("@acme/core/utils"))).toEqual({
			status: "local",
			target: "packages/core/src/utils.ts",
		});
		expect(r.resolve("src/app.ts", site("@acme/core/feature/flags"))).toEqual({
			status: "local",
			target: "packages/core/src/feature/flags.ts",
		});
	});

	test("exports encapsulation: an unlisted subpath is unresolved, not a file probe", async () => {
		await put(
			"packages/core/package.json",
			JSON.stringify({ name: "@acme/core", exports: { ".": "./src/index.ts" } }),
		);
		await put("packages/core/src/index.ts", "");
		await put("packages/core/src/secret.ts", "");
		await put("src/app.ts", "");
		const r = await resolver();
		const resolution = r.resolve("src/app.ts", site("@acme/core/secret"));
		expect(resolution.status).toBe("unresolved");
		expect(resolution).toMatchObject({ reason: "exports-encapsulation" });
	});

	test("packages without exports resolve via main, then types, then index", async () => {
		await put("packages/lib/package.json", JSON.stringify({ name: "lib", main: "./src/main.ts" }));
		await put("packages/lib/src/main.ts", "");
		await put("packages/plain/package.json", JSON.stringify({ name: "plain" }));
		await put("packages/plain/index.ts", "");
		await put("src/app.ts", "");
		const r = await resolver();
		expect(r.resolve("src/app.ts", site("lib"))).toEqual({
			status: "local",
			target: "packages/lib/src/main.ts",
		});
		// No exports map: subpaths resolve as plain files inside the package.
		expect(r.resolve("src/app.ts", site("lib/src/main"))).toEqual({
			status: "local",
			target: "packages/lib/src/main.ts",
		});
		expect(r.resolve("src/app.ts", site("plain"))).toEqual({
			status: "local",
			target: "packages/plain/index.ts",
		});
	});

	test("a workspace package whose entry points are absent is unresolved", async () => {
		await put(
			"packages/core/package.json",
			JSON.stringify({ name: "@acme/core", main: "./dist/main.js" }),
		);
		await put("src/app.ts", "");
		const r = await resolver();
		const resolution = r.resolve("src/app.ts", site("@acme/core"));
		expect(resolution.status).toBe("unresolved");
		expect(resolution).toMatchObject({ reason: "no-target" });
	});
});

describe("createGraphResolver unbuilt workspace packages (trellis-a98b)", () => {
	beforeEach(async () => {
		await put("package.json", JSON.stringify({ name: "app", workspaces: ["packages/*"] }));
		await put("src/app.ts", "");
	});

	test("maps absent dist exports back to source by convention", async () => {
		await put(
			"packages/core/package.json",
			JSON.stringify({
				name: "@acme/core",
				exports: {
					".": { import: { types: "./dist/index.d.mts", default: "./dist/index.mjs" } },
					"./feature/*": { import: "./dist/feature/*.js" },
				},
			}),
		);
		await put("packages/core/src/index.ts", "");
		await put("packages/core/src/feature/flags.tsx", "");
		const r = await resolver();
		expect(r.resolve("src/app.ts", site("@acme/core"))).toEqual({
			status: "local",
			target: "packages/core/src/index.ts",
		});
		expect(r.resolve("src/app.ts", site("@acme/core/feature/flags"))).toEqual({
			status: "local",
			target: "packages/core/src/feature/flags.tsx",
		});
	});

	test("maps main/types through the package tsconfig outDir and rootDir", async () => {
		await put(
			"packages/lib/package.json",
			JSON.stringify({ name: "lib", main: "./out/cjs/index.js", types: "./out/cjs/index.d.ts" }),
		);
		await put(
			"packages/lib/tsconfig.build.json",
			JSON.stringify({ compilerOptions: { outDir: "out/cjs", rootDir: "source" } }),
		);
		await put("packages/lib/source/index.ts", "");
		const r = await resolver();
		expect(r.resolve("src/app.ts", site("lib"))).toEqual({
			status: "local",
			target: "packages/lib/source/index.ts",
		});
	});

	test("a built entry still resolves to the existing output file first", async () => {
		await put(
			"packages/core/package.json",
			JSON.stringify({ name: "@acme/core", exports: { ".": "./dist/index.js" } }),
		);
		await put("packages/core/dist/index.js", "");
		await put("packages/core/src/index.ts", "");
		const r = await resolver();
		expect(r.resolve("src/app.ts", site("@acme/core"))).toMatchObject({
			target: "packages/core/dist/index.js",
		});
	});

	test("stays unresolved when no mapped source exists", async () => {
		await put(
			"packages/core/package.json",
			JSON.stringify({ name: "@acme/core", exports: { ".": "./dist/index.js" } }),
		);
		const r = await resolver();
		expect(r.resolve("src/app.ts", site("@acme/core"))).toMatchObject({
			status: "unresolved",
			reason: "no-target",
		});
	});
});

describe("createGraphResolver external classification", () => {
	test("bare specifiers outside aliases and workspace names are external, install-state independent", async () => {
		// No node_modules anywhere: externals classify identically (SPEC §8).
		await put("src/a.ts", "");
		const r = await resolver();
		expect(r.resolve("src/a.ts", site("zod"))).toEqual({
			status: "external",
			packageName: "zod",
		});
		expect(r.resolve("src/a.ts", site("@scope/thing/deep"))).toEqual({
			status: "external",
			packageName: "@scope/thing",
		});
		expect(r.resolve("src/a.ts", site("node:fs"))).toEqual({
			status: "external",
			packageName: "node:fs",
		});
	});

	test("a non-literal dynamic import is unresolved with its own reason", async () => {
		await put("src/a.ts", "");
		const r = await resolver();
		const resolution = r.resolve("src/a.ts", { ...site("ignored"), specifier: null });
		expect(resolution).toMatchObject({ status: "unresolved", reason: "non-literal-dynamic" });
	});
});
