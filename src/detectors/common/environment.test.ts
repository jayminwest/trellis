import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDetectionContext } from "../context.ts";
import type { DetectionContext } from "../types.ts";
import { depsPinned, devcontainer, envTemplate, gitignoreComprehensive } from "./environment.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function repo(files: Record<string, string>): Promise<DetectionContext> {
	const root = await mkdtemp(join(tmpdir(), "trellis-env-"));
	dirs.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(root, rel);
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, content);
	}
	return createDetectionContext(root, { path: ".", languages: ["typescript"] });
}

describe("envTemplate", () => {
	test("passes when a committed env example exists", async () => {
		const r = await envTemplate(await repo({ ".env.example": "KEY=\n" }));
		expect(r.numerator).toBe(1);
	});

	test("fails when no env template is committed", async () => {
		const r = await envTemplate(await repo({ "README.md": "" }));
		expect(r.numerator).toBe(0);
		expect(r.naKind).toBeUndefined();
	});
});

describe("gitignoreComprehensive", () => {
	test("passes a .gitignore with enough real patterns", async () => {
		const r = await gitignoreComprehensive(
			await repo({ ".gitignore": "node_modules\ndist\ncoverage\n.env\n*.log\nbuild\n" }),
		);
		expect(r.numerator).toBe(1);
	});

	test("fails a sparse .gitignore (comments/blanks don't count)", async () => {
		const r = await gitignoreComprehensive(
			await repo({ ".gitignore": "# only a comment\n\nnode_modules\n" }),
		);
		expect(r.numerator).toBe(0);
	});

	test("fails when there is no .gitignore", async () => {
		expect((await gitignoreComprehensive(await repo({ x: "" }))).numerator).toBe(0);
	});
});

describe("depsPinned", () => {
	test("passes when a lockfile is committed", async () => {
		expect((await depsPinned(await repo({ "bun.lock": "" }))).numerator).toBe(1);
	});

	test("fails with no lockfile", async () => {
		expect((await depsPinned(await repo({ "package.json": "{}" }))).numerator).toBe(0);
	});
});

describe("devcontainer", () => {
	test("passes with a .devcontainer/devcontainer.json", async () => {
		expect(
			(await devcontainer(await repo({ ".devcontainer/devcontainer.json": "{}" }))).numerator,
		).toBe(1);
	});

	test("passes with a root .devcontainer.json", async () => {
		expect((await devcontainer(await repo({ ".devcontainer.json": "{}" }))).numerator).toBe(1);
	});

	test("fails when absent", async () => {
		expect((await devcontainer(await repo({ "README.md": "" }))).numerator).toBe(0);
	});
});
