import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDetectionContext } from "../../context.ts";
import type { DetectionContext } from "../../types.ts";
import { firstPresent, gatherToolingText, locateTool, toolingMentions } from "./util.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function repo(files: Record<string, string>): Promise<DetectionContext> {
	const root = await mkdtemp(join(tmpdir(), "trellis-python-util-"));
	dirs.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(root, rel);
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, content);
	}
	return createDetectionContext(root, { path: ".", languages: ["python"] });
}

describe("firstPresent", () => {
	test("returns the first existing candidate in order", async () => {
		const ctx = await repo({ ".ruff.toml": "" });
		expect(await firstPresent(ctx, ["ruff.toml", ".ruff.toml"])).toBe(".ruff.toml");
	});

	test("returns null when none exist", async () => {
		expect(await firstPresent(await repo({}), ["ruff.toml"])).toBeNull();
	});
});

describe("locateTool", () => {
	test("finds a dedicated config file", async () => {
		const where = await locateTool(await repo({ "ruff.toml": "line-length = 100\n" }), {
			files: ["ruff.toml"],
		});
		expect(where).toBe("'ruff.toml'");
	});

	test("finds a [tool.X] table in pyproject.toml", async () => {
		const where = await locateTool(
			await repo({ "pyproject.toml": "[tool.ruff]\nline-length = 100\n" }),
			{
				configRe: /\[tool\.ruff\b/,
			},
		);
		expect(where).toBe("'pyproject.toml'");
	});

	test("finds an INI section in setup.cfg", async () => {
		const where = await locateTool(
			await repo({ "setup.cfg": "[flake8]\nmax-line-length = 100\n" }),
			{
				configRe: /\[flake8\]/,
			},
		);
		expect(where).toBe("'setup.cfg'");
	});

	test("falls back to a build-tooling mention", async () => {
		const where = await locateTool(await repo({ Makefile: "lint:\n\truff check .\n" }), {
			configRe: /\[tool\.ruff\b/,
			mention: /\bruff\b/,
		});
		expect(where).toBe("build tooling");
	});

	test("returns null when configured nowhere", async () => {
		expect(
			await locateTool(await repo({ "pyproject.toml": "[project]\n" }), {
				files: ["ruff.toml"],
				mention: /\bruff\b/,
			}),
		).toBeNull();
	});
});

describe("gatherToolingText", () => {
	test("concatenates manifest, INI config, build glue, requirements, and CI", async () => {
		const text = await gatherToolingText(
			await repo({
				"pyproject.toml": "[tool.ruff]\n",
				"tox.ini": "[flake8]\n",
				Makefile: "test:\n\tpytest\n",
				"requirements-dev.txt": "vulture==2.0\n",
				".github/workflows/ci.yml": "run: deptry .\n",
			}),
		);
		expect(toolingMentions(text, /ruff/)).toBe(true);
		expect(toolingMentions(text, /pytest/)).toBe(true);
		expect(toolingMentions(text, /vulture/)).toBe(true);
		expect(toolingMentions(text, /deptry/)).toBe(true);
	});

	test("returns empty string when nothing is present", async () => {
		expect(await gatherToolingText(await repo({}))).toBe("");
	});
});
