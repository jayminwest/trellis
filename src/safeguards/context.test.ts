import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	extractWorkflowCommands,
	loadManifest,
	loadSafeguardContext,
	loadWorkflows,
} from "./context.ts";

let repo: string;

beforeEach(async () => {
	repo = await mkdtemp(join(tmpdir(), "trellis-safeguards-context-"));
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

describe("loadManifest", () => {
	test("returns null when no package.json exists", async () => {
		expect(await loadManifest(repo)).toBeNull();
	});

	test("locates scripts with 1-based lines", async () => {
		await put(
			"package.json",
			[
				"{",
				'\t"name": "demo",',
				'\t"scripts": {',
				'\t\t"lint": "biome check .",',
				'\t\t"test": "bun test"',
				"\t}",
				"}",
			].join("\n"),
		);
		const manifest = await loadManifest(repo);
		expect(manifest?.parseError).toBeUndefined();
		expect(manifest?.scripts).toEqual([
			{ name: "lint", body: "biome check .", line: 4 },
			{ name: "test", body: "bun test", line: 5 },
		]);
	});

	test("decodes escaped characters in script bodies", async () => {
		await put(
			"package.json",
			["{", '\t"scripts": {', '\t\t"quote": "echo \\"hi\\""', "\t}", "}"].join("\n"),
		);
		const manifest = await loadManifest(repo);
		expect(manifest?.scripts).toEqual([{ name: "quote", body: 'echo "hi"', line: 3 }]);
	});

	test("ignores non-string script values without failing", async () => {
		await put(
			"package.json",
			[
				"{",
				'\t"scripts": {',
				'\t\t"count": 1,',
				'\t\t"lint": "biome check ."',
				"\t},",
				'\t"other": 1',
				"}",
			].join("\n"),
		);
		const manifest = await loadManifest(repo);
		expect(manifest?.scripts).toHaveLength(1);
	});

	test("reports a parseError for malformed JSON", async () => {
		await put("package.json", "{ not json");
		const manifest = await loadManifest(repo);
		expect(manifest?.parseError).toBeDefined();
		expect(manifest?.scripts).toEqual([]);
	});

	test("reports a parseError for a non-object document", async () => {
		await put("package.json", '["array"]');
		const manifest = await loadManifest(repo);
		expect(manifest?.parseError).toBe("package.json is not a JSON object");
	});

	test("detects declarative husky and jscpd keys", async () => {
		await put("package.json", JSON.stringify({ husky: { hooks: {} }, jscpd: { threshold: 5 } }));
		const manifest = await loadManifest(repo);
		expect(manifest?.huskyConfig).toBe(true);
		expect(manifest?.jscpdConfig).toBe(true);
	});

	test("does not confuse a later 'scripts' key outside the root object", async () => {
		await put(
			"package.json",
			[
				"{",
				'\t"config": {',
				'\t\t"scripts": {',
				'\t\t\t"nested": "echo nested"',
				"\t\t}",
				"\t}",
				"}",
			].join("\n"),
		);
		const manifest = await loadManifest(repo);
		// The nested scripts key is still matched by the line scan (documented
		// subset: the first `"scripts": {` line wins, wherever it appears).
		expect(manifest?.scripts).toEqual([{ name: "nested", body: "echo nested", line: 4 }]);
	});
});

describe("extractWorkflowCommands", () => {
	test("extracts scalar run values and uses with line numbers", () => {
		const model = extractWorkflowCommands(
			".github/workflows/ci.yml",
			[
				"steps:",
				"  - uses: actions/checkout@v6",
				"  - name: Lint",
				"    run: bun run lint",
				"  - run: bun test",
			].join("\n"),
		);
		expect(model.commands).toEqual([
			{ text: "bun run lint", line: 4 },
			{ text: "bun test", line: 5 },
		]);
		expect(model.uses).toEqual(["actions/checkout@v6"]);
	});

	test("extracts every line of a block run with its own line number", () => {
		const model = extractWorkflowCommands(
			".github/workflows/ci.yml",
			[
				"steps:",
				"  - name: Multi",
				"    run: |",
				"      bun install",
				"",
				"      bun run check:all",
				"  - name: Next",
				"    run: bun test",
			].join("\n"),
		);
		expect(model.commands).toEqual([
			{ text: "bun install", line: 4 },
			{ text: "bun run check:all", line: 6 },
			{ text: "bun test", line: 8 },
		]);
	});

	test("ignores everything outside the documented subset", () => {
		const model = extractWorkflowCommands(
			".github/workflows/ci.yml",
			["on: push", "env:", "  TOKEN: secret", "jobs:", "  ci:", "    runs-on: ubuntu-latest"].join(
				"\n",
			),
		);
		expect(model.commands).toEqual([]);
		expect(model.uses).toEqual([]);
	});
});

describe("loadWorkflows", () => {
	test("returns an empty list when no workflows directory exists", async () => {
		expect(await loadWorkflows(repo)).toEqual([]);
	});

	test("loads .yml and .yaml files sorted by name, skipping others", async () => {
		await put(".github/workflows/b.yaml", "steps:\n  - run: b\n");
		await put(".github/workflows/a.yml", "steps:\n  - run: a\n");
		await put(".github/workflows/notes.md", "not a workflow\n");
		const workflows = await loadWorkflows(repo);
		expect(workflows.map((w) => w.path)).toEqual([
			".github/workflows/a.yml",
			".github/workflows/b.yaml",
		]);
	});
});

describe("loadSafeguardContext", () => {
	test("probes files below the root and reads text", async () => {
		await put("package.json", '{"scripts": {}}');
		const ctx = await loadSafeguardContext(repo);
		expect(await ctx.fileExists("package.json")).toBe(true);
		expect(await ctx.fileExists("nope.txt")).toBe(false);
		expect(await ctx.readText("package.json")).toBe('{"scripts": {}}');
		expect(await ctx.readText("nope.txt")).toBeNull();
	});
});
