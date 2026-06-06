import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDetectionContext } from "../context.ts";
import type { DetectionContext } from "../types.ts";
import {
	anyWorkflowMatches,
	firstHit,
	globHits,
	packageDeps,
	packageScripts,
	readJson,
	readWorkflows,
} from "./util.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** Materialize `files` (relpath → contents) into a temp repo and return a context over it. */
async function repo(files: Record<string, string>): Promise<DetectionContext> {
	const root = await mkdtemp(join(tmpdir(), "trellis-util-"));
	dirs.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(root, rel);
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, content);
	}
	return createDetectionContext(root, { path: ".", languages: ["typescript"] });
}

describe("globHits", () => {
	test("dedupes across patterns and sorts", async () => {
		const ctx = await repo({ "a.txt": "", "b.txt": "" });
		expect(await globHits(ctx, ["*.txt", "a.txt"])).toEqual(["a.txt", "b.txt"]);
	});

	test("returns empty when nothing matches", async () => {
		expect(await globHits(await repo({ "a.txt": "" }), ["*.md"])).toEqual([]);
	});
});

describe("firstHit", () => {
	test("returns the first sorted match or null", async () => {
		const ctx = await repo({ "z.txt": "", "a.txt": "" });
		expect(await firstHit(ctx, ["*.txt"])).toBe("a.txt");
		expect(await firstHit(ctx, ["*.md"])).toBeNull();
	});
});

describe("readJson", () => {
	test("parses an object", async () => {
		const ctx = await repo({ "p.json": '{"a":1}' });
		expect(await readJson(ctx, "p.json")).toEqual({ a: 1 });
	});

	test("returns null for absent, malformed, or non-object JSON", async () => {
		const ctx = await repo({ "bad.json": "{not json", "arr.json": "[1,2]" });
		expect(await readJson(ctx, "missing.json")).toBeNull();
		expect(await readJson(ctx, "bad.json")).toBeNull();
		expect(await readJson(ctx, "arr.json")).toBeNull();
	});
});

describe("readWorkflows / anyWorkflowMatches", () => {
	test("reads GitHub + GitLab CI and matches contents", async () => {
		const ctx = await repo({
			".github/workflows/ci.yml": "name: ci\njobs: {}",
			".gitlab-ci.yml": "stages:\n  - test",
		});
		const wfs = await readWorkflows(ctx);
		expect(wfs.map((w) => w.path)).toEqual([".github/workflows/ci.yml", ".gitlab-ci.yml"]);
		expect(anyWorkflowMatches(wfs, /stages/)).toBe(true);
		expect(anyWorkflowMatches(wfs, /nonexistent/)).toBe(false);
	});
});

describe("packageScripts / packageDeps", () => {
	test("extracts string scripts and the union of dep names", () => {
		const pkg = {
			scripts: { test: "bun test", bad: 1 },
			dependencies: { a: "1" },
			devDependencies: { b: "2" },
		};
		expect(packageScripts(pkg)).toEqual({ test: "bun test" });
		expect([...packageDeps(pkg)].sort()).toEqual(["a", "b"]);
	});

	test("tolerate null / missing maps", () => {
		expect(packageScripts(null)).toEqual({});
		expect([...packageDeps(null)]).toEqual([]);
		expect([...packageDeps({})]).toEqual([]);
	});
});
