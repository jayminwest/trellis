import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSourceInventory, toSourceCoverage } from "./inventory.ts";

let repo: string;

beforeEach(async () => {
	repo = await mkdtemp(join(tmpdir(), "trellis-inv-"));
});

afterEach(async () => {
	await rm(repo, { recursive: true, force: true });
});

/** Write `content` to `relPath` under the temp repo, creating parent dirs. */
async function put(relPath: string, content = ""): Promise<void> {
	const abs = join(repo, relPath);
	await mkdir(join(abs, ".."), { recursive: true });
	await writeFile(abs, content);
}

describe("discoverSourceInventory single package (non-Git tree)", () => {
	test("classifies production, test, and TSX under the root package", async () => {
		await put("package.json", JSON.stringify({ name: "app", main: "./src/index.ts" }));
		await put("src/index.ts", "export const x = 1;\n");
		await put("src/view.tsx", "export const V = () => null;\n");
		await put("src/index.test.ts", "test('x', () => {});\n");

		const inv = await discoverSourceInventory(repo);
		expect(inv.packages).toEqual([{ path: ".", name: "app", hasManifest: true, declared: true }]);
		expect(inv.files).toEqual([
			{ path: "src/index.test.ts", sourceSet: "test", packagePath: ".", rule: "default:test" },
			{
				path: "src/index.ts",
				sourceSet: "production",
				packagePath: ".",
				rule: "default:production",
			},
			{
				path: "src/view.tsx",
				sourceSet: "production",
				packagePath: ".",
				rule: "default:production",
			},
		]);
	});

	test("a repo without package.json still inventories under an implicit root package", async () => {
		await put("src/a.ts", "export {}\n");
		const inv = await discoverSourceInventory(repo);
		expect(inv.packages).toEqual([{ path: ".", hasManifest: false, declared: false }]);
		expect(inv.files[0]?.packagePath).toBe(".");
	});

	test("uncommitted files are seen identically — no Git is consulted", async () => {
		await put("src/dirty.ts", "// uncommitted\n");
		const inv = await discoverSourceInventory(repo);
		expect(inv.files.map((file) => file.path)).toEqual(["src/dirty.ts"]);
	});
});

describe("discoverSourceInventory nested workspaces", () => {
	test("workspace packages own their files; nested packages are never double-counted", async () => {
		await put("package.json", JSON.stringify({ name: "mono", workspaces: ["packages/*"] }));
		await put("packages/a/package.json", JSON.stringify({ name: "@mono/a" }));
		await put("packages/a/src/a.ts", "export {}\n");
		await put("packages/b/package.json", JSON.stringify({ name: "@mono/b" }));
		await put("packages/b/src/b.ts", "export {}\n");
		await put("src/root.ts", "export {}\n");

		const inv = await discoverSourceInventory(repo);
		expect(inv.packages.map((pkg) => pkg.path)).toEqual([".", "packages/a", "packages/b"]);
		expect(inv.packages.every((pkg) => pkg.declared)).toBe(true);
		const byPath = new Map(inv.files.map((file) => [file.path, file]));
		expect(byPath.get("packages/a/src/a.ts")?.packagePath).toBe("packages/a");
		expect(byPath.get("packages/b/src/b.ts")?.packagePath).toBe("packages/b");
		expect(byPath.get("src/root.ts")?.packagePath).toBe(".");
		// Exactly one entry per file — no double counting.
		expect(inv.files.map((file) => file.path).sort()).toEqual([
			...new Set(inv.files.map((file) => file.path)),
		]);
	});

	test("an undeclared nested manifest is still a package boundary", async () => {
		await put("package.json", JSON.stringify({ name: "mono", workspaces: ["packages/*"] }));
		await put("extras/inner/package.json", JSON.stringify({ name: "inner" }));
		await put("extras/inner/src/x.ts", "export {}\n");

		const inv = await discoverSourceInventory(repo);
		const inner = inv.packages.find((pkg) => pkg.path === "extras/inner");
		expect(inner?.declared).toBe(false);
		expect(inv.files[0]?.packagePath).toBe("extras/inner");
	});

	test("pnpm-workspace.yaml declares packages, honoring ! negation", async () => {
		await put("package.json", JSON.stringify({ name: "mono" }));
		await put("pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n  - '!packages/legacy'\n");
		await put("packages/legacy/package.json", JSON.stringify({ name: "legacy" }));
		await put("packages/ok/package.json", JSON.stringify({ name: "ok" }));

		const inv = await discoverSourceInventory(repo);
		expect(inv.packages.find((pkg) => pkg.path === "packages/ok")?.declared).toBe(true);
		expect(inv.packages.find((pkg) => pkg.path === "packages/legacy")?.declared).toBe(false);
	});

	test("workspaces as an object with a packages key is honored", async () => {
		await put(
			"package.json",
			JSON.stringify({ name: "mono", workspaces: { packages: ["modules/*"] } }),
		);
		await put("modules/m/package.json", JSON.stringify({ name: "m" }));
		const inv = await discoverSourceInventory(repo);
		expect(inv.packages.find((pkg) => pkg.path === "modules/m")?.declared).toBe(true);
	});
});

describe("discoverSourceInventory classification scopes", () => {
	test("generated, vendored, and declaration-only defaults apply", async () => {
		await put("package.json", JSON.stringify({ name: "app" }));
		await put("src/generated/client.ts", "export {}\n");
		await put("vendor/lib/v.ts", "export {}\n");
		await put("types/index.d.ts", "export {};\n");

		const inv = await discoverSourceInventory(repo);
		const sets = new Map(inv.files.map((file) => [file.path, file.sourceSet]));
		expect(sets.get("src/generated/client.ts")).toBe("generated");
		expect(sets.get("vendor/lib/v.ts")).toBe("vendored");
		expect(sets.get("types/index.d.ts")).toBe("declaration-only");
	});

	test("config exclude globs and build outputs land in the excluded scope, not the scored sets", async () => {
		await put("package.json", JSON.stringify({ name: "app" }));
		await put("src/index.ts", "export {}\n");
		await put("src/fixtures/fake.ts", "export {}\n");
		await put("dist/index.d.ts", "export {};\n");
		await put("build/out.ts", "export {}\n");

		const inv = await discoverSourceInventory(repo, {
			source: { exclude: ["src/fixtures/**"], classify: {} },
		});
		expect(inv.files.map((file) => file.path)).toEqual(["src/index.ts"]);
		expect(inv.excluded).toEqual([
			{ path: "build/out.ts", reason: "build-output" },
			{ path: "dist/index.d.ts", reason: "build-output" },
			{ path: "src/fixtures/fake.ts", reason: "config-exclude" },
		]);
	});

	test("config classify overrides assign explicit source sets", async () => {
		await put("package.json", JSON.stringify({ name: "app" }));
		await put("scripts/tools/build.ts", "export {}\n");

		const inv = await discoverSourceInventory(repo, {
			source: { exclude: [], classify: { "scripts/tools/**": "test" } },
		});
		expect(inv.files[0]).toMatchObject({
			sourceSet: "test",
			rule: "config:classify:scripts/tools/**",
		});
	});

	test("non-TS source files and whole non-TS packages are reported as unsupported", async () => {
		await put("package.json", JSON.stringify({ name: "poly" }));
		await put("src/index.ts", "export {}\n");
		await put("scripts/gen.py", "print(1)\n");
		await put("ios/package.json", JSON.stringify({ name: "ios" }));
		await put("ios/App.swift", "import UIKit\n");

		const inv = await discoverSourceInventory(repo);
		expect(inv.unsupported).toEqual({ files: 2, byExtension: { ".py": 1, ".swift": 1 } });
		expect(inv.unsupportedPackages).toEqual(["ios"]);
	});

	test("node_modules and dot dirs are ignored by path, never descended into", async () => {
		await put("package.json", JSON.stringify({ name: "app" }));
		await put("node_modules/dep/index.ts", "export {}\n");
		await put(".hidden/secret.ts", "export {}\n");
		await put("src/real.ts", "export {}\n");

		const inv = await discoverSourceInventory(repo);
		expect(inv.files.map((file) => file.path)).toEqual(["src/real.ts"]);
		expect(inv.excluded).toEqual([]);
		expect(inv.ignored).toEqual([
			{ path: ".hidden", reason: "dot-dir" },
			{ path: "node_modules", reason: "dependency-dir" },
		]);
	});
});

describe("discoverSourceInventory symlinks", () => {
	test("directory symlinks are not followed and are reported; file symlinks are followed", async () => {
		await put("real/a.ts", "export {}\n");
		await symlink(join(repo, "real"), join(repo, "linked"), "dir");
		await symlink(join(repo, "real", "a.ts"), join(repo, "alias.ts"), "file");

		const inv = await discoverSourceInventory(repo);
		expect(inv.files.map((file) => file.path).sort()).toEqual(["alias.ts", "real/a.ts"]);
		expect(inv.ignored).toEqual([{ path: "linked", reason: "symlink" }]);
	});

	test("a broken symlink is reported, not followed", async () => {
		await symlink(join(repo, "missing"), join(repo, "dangling"), "dir");
		const inv = await discoverSourceInventory(repo);
		expect(inv.ignored).toEqual([{ path: "dangling", reason: "symlink" }]);
	});
});

describe("discoverSourceInventory determinism", () => {
	test("two runs over the same tree produce identical inventories", async () => {
		await put("package.json", JSON.stringify({ name: "app", workspaces: ["packages/*"] }));
		await put("packages/a/package.json", JSON.stringify({ name: "a" }));
		await put("packages/a/src/a.ts", "export {}\n");
		await put("src/z.ts", "export {}\n");
		await put("src/b.test.ts", "export {}\n");
		await put("tool.py", "pass\n");

		const first = await discoverSourceInventory(repo);
		const second = await discoverSourceInventory(repo);
		expect(first).toEqual(second);
	});
});

describe("toSourceCoverage", () => {
	test("projects per-scope file counts onto the §6.4 contract shape", async () => {
		await put("package.json", JSON.stringify({ name: "app" }));
		await put("src/index.ts", "export {}\n");
		await put("src/index.test.ts", "export {}\n");
		await put("src/generated/g.ts", "export {}\n");
		await put("dist/bundle.d.ts", "export {};\n");
		await put("tool.py", "pass\n");

		const coverage = toSourceCoverage(await discoverSourceInventory(repo));
		expect(coverage).toEqual({
			production: { files: 1 },
			test: { files: 1 },
			generated: { files: 1 },
			excluded: { files: 1, note: "build outputs and config-excluded paths — not analyzed" },
			unsupported: { files: 1, note: "non-TS sources, not analyzed" },
		});
	});

	test("empty scopes are omitted beyond the always-present production/test", async () => {
		await put("src/a.ts", "export {}\n");
		const coverage = toSourceCoverage(await discoverSourceInventory(repo));
		expect(coverage).toEqual({ production: { files: 1 }, test: { files: 0 } });
	});
});
