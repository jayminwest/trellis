import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverApps, toAppMap } from "./discover.ts";

let repo: string;

beforeEach(async () => {
	repo = await mkdtemp(join(tmpdir(), "trellis-disc-"));
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

describe("discoverApps single-app root", () => {
	test("a root package.json with bin is one app at '.'", async () => {
		await put("package.json", JSON.stringify({ name: "trellis", bin: { trellis: "./cli.ts" } }));
		const apps = await discoverApps(repo);
		expect(apps).toEqual([{ path: ".", languages: ["typescript"], description: "trellis" }]);
	});

	test("a root package.json with main is one app at '.'", async () => {
		await put("package.json", JSON.stringify({ name: "lib", main: "./index.ts" }));
		const apps = await discoverApps(repo);
		expect(apps).toEqual([{ path: ".", languages: ["typescript"], description: "lib" }]);
	});

	test("description falls back to package description then dir basename", async () => {
		await put("package.json", JSON.stringify({ description: "a tool", main: "./i.ts" }));
		const [app] = await discoverApps(repo);
		expect(app?.description).toBe("a tool");
	});
});

describe("discoverApps fallback (0 found → root is 1 app)", () => {
	test("a repo with no deployable marker yields the root as one app", async () => {
		await put("README.md", "# docs\n");
		const apps = await discoverApps(repo);
		expect(apps).toHaveLength(1);
		expect(apps[0]?.path).toBe(".");
		expect(apps[0]?.languages).toEqual([]);
	});

	test("package.json without bin/main is not an app — falls back to root with detected langs", async () => {
		await put("package.json", JSON.stringify({ name: "no-entry" }));
		await put("tsconfig.json", "{}");
		const apps = await discoverApps(repo);
		expect(apps).toEqual([
			{ path: ".", languages: ["typescript"], description: expect.any(String) },
		]);
	});

	test("setup.cfg alone is language-only, not an app marker", async () => {
		await put("setup.cfg", "[metadata]\n");
		const apps = await discoverApps(repo);
		expect(apps).toHaveLength(1);
		expect(apps[0]?.path).toBe(".");
		expect(apps[0]?.languages).toEqual(["python"]);
	});
});

describe("discoverApps multi-app monorepo", () => {
	test("warren-like src/ui + root server are both discovered, sorted by path", async () => {
		await put("package.json", JSON.stringify({ name: "server", main: "./server.ts" }));
		await put("src/ui/package.json", JSON.stringify({ name: "warren-ui", main: "./ui.ts" }));
		const apps = await discoverApps(repo);
		expect(apps).toEqual([
			{ path: ".", languages: ["typescript"], description: "server" },
			{ path: "src/ui", languages: ["typescript"], description: "warren-ui" },
		]);
	});

	test("mixed-language monorepo detects swift and python apps", async () => {
		await put("services/api/Package.swift", "// swift\n");
		await put("services/worker/pyproject.toml", "[project]\n");
		const apps = await discoverApps(repo);
		expect(apps).toEqual([
			{ path: "services/api", languages: ["swift"], description: "api" },
			{ path: "services/worker", languages: ["python"], description: "worker" },
		]);
	});

	test("a Dockerfile marks a service directory as an app", async () => {
		await put("svc/Dockerfile", "FROM scratch\n");
		const apps = await discoverApps(repo);
		expect(apps.map((a) => a.path)).toEqual(["svc"]);
	});
});

describe("discoverApps languages hint", () => {
	test("the targets.yaml hint overrides auto-detection for every app", async () => {
		await put("package.json", JSON.stringify({ name: "app", main: "./i.ts" }));
		const apps = await discoverApps(repo, { languages: ["swift"] });
		expect(apps[0]?.languages).toEqual(["swift"]);
	});

	test("the hint is de-duped and sorted", async () => {
		await put("package.json", JSON.stringify({ name: "app", main: "./i.ts" }));
		const apps = await discoverApps(repo, { languages: ["typescript", "python", "typescript"] });
		expect(apps[0]?.languages).toEqual(["python", "typescript"]);
	});

	test("the hint applies to the fallback root app too", async () => {
		await put("README.md", "# docs\n");
		const apps = await discoverApps(repo, { languages: ["python"] });
		expect(apps).toEqual([{ path: ".", languages: ["python"], description: expect.any(String) }]);
	});
});

describe("discoverApps exclusion rules", () => {
	test("manifests under node_modules / vendor / build outputs are excluded", async () => {
		await put("package.json", JSON.stringify({ name: "root", main: "./i.ts" }));
		await put("node_modules/dep/package.json", JSON.stringify({ name: "dep", main: "./d.ts" }));
		await put("vendor/lib/Package.swift", "// swift\n");
		await put("dist/bundle/package.json", JSON.stringify({ name: "bundle", main: "./b.ts" }));
		const apps = await discoverApps(repo);
		expect(apps.map((a) => a.path)).toEqual(["."]);
	});

	test("dot-directories are not descended into", async () => {
		await put("package.json", JSON.stringify({ name: "root", main: "./i.ts" }));
		await put(".cache/x/pyproject.toml", "[project]\n");
		const apps = await discoverApps(repo);
		expect(apps.map((a) => a.path)).toEqual(["."]);
	});

	test("maxDepth bounds the descent", async () => {
		await put("a/b/c/package.json", JSON.stringify({ name: "deep", main: "./i.ts" }));
		const shallow = await discoverApps(repo, { maxDepth: 1 });
		expect(shallow.map((a) => a.path)).toEqual(["."]); // not found → fallback root
		const deep = await discoverApps(repo, { maxDepth: 3 });
		expect(deep.map((a) => a.path)).toEqual(["a/b/c"]);
	});
});

describe("toAppMap", () => {
	test("projects apps onto the §6.3 { path: { description } } shape", () => {
		const map = toAppMap([
			{ path: ".", languages: ["typescript"], description: "server" },
			{ path: "src/ui", languages: ["typescript"], description: "warren-ui" },
		]);
		expect(map).toEqual({
			".": { description: "server" },
			"src/ui": { description: "warren-ui" },
		});
	});
});
