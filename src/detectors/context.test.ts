import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDetectionContext, SPAWN_FAILURE_EXIT } from "./context.ts";

let repo: string;

beforeAll(async () => {
	repo = await mkdtemp(join(tmpdir(), "trellis-ctx-"));
	await writeFile(join(repo, "README.md"), "# hello\n");
	await mkdir(join(repo, "src"), { recursive: true });
	await writeFile(join(repo, "src", "a.ts"), "export const a = 1;\n");
	await writeFile(join(repo, "src", "b.ts"), "export const b = 2;\n");
});

afterAll(async () => {
	await rm(repo, { recursive: true, force: true });
});

const make = () => createDetectionContext(repo, { path: ".", languages: ["typescript"] });

describe("readFile", () => {
	test("reads a file relative to the app root", async () => {
		expect(await make().readFile("README.md")).toBe("# hello\n");
	});

	test("returns null for an absent file", async () => {
		expect(await make().readFile("nope.md")).toBeNull();
	});

	test("returns null for a path that escapes the repo", async () => {
		expect(await make().readFile("../../../etc/passwd")).toBeNull();
	});
});

describe("glob", () => {
	test("returns sorted matches relative to the app root", async () => {
		expect(await make().glob("src/*.ts")).toEqual(["src/a.ts", "src/b.ts"]);
	});

	test("returns empty for no match", async () => {
		expect(await make().glob("**/*.swift")).toEqual([]);
	});
});

describe("app-scope rooting", () => {
	test("readFile/glob root at the app subdirectory", async () => {
		const ctx = createDetectionContext(repo, { path: "src", languages: ["typescript"] });
		expect(await ctx.readFile("a.ts")).toBe("export const a = 1;\n");
		expect(await ctx.glob("*.ts")).toEqual(["a.ts", "b.ts"]);
	});
});

describe("run", () => {
	test("captures exit code and stdout", async () => {
		const r = await make().run(["printf", "hi"]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toBe("hi");
		expect(r.timedOut).toBe(false);
	});

	test("captures a non-zero exit code", async () => {
		const r = await make().run(["sh", "-c", "exit 3"]);
		expect(r.exitCode).toBe(3);
	});

	test("runs sandboxed to the repo cwd", async () => {
		// pwd reports the realpath; on macOS /var is a symlink to /private/var.
		const r = await make().run(["pwd", "-P"]);
		const { realpathSync } = await import("node:fs");
		expect(r.stdout.trim()).toBe(realpathSync(repo));
	});

	test("maps a missing tool to exit 127, not a throw", async () => {
		const r = await make().run(["definitely-not-a-real-binary-xyz"]);
		expect(r.exitCode).toBe(SPAWN_FAILURE_EXIT);
		expect(r.timedOut).toBe(false);
	});

	test("maps empty argv to a spawn failure", async () => {
		const r = await make().run([]);
		expect(r.exitCode).toBe(SPAWN_FAILURE_EXIT);
	});

	test("kills and flags a run that exceeds its timeout", async () => {
		const ctx = createDetectionContext(
			repo,
			{ path: ".", languages: ["typescript"] },
			{
				timeoutMs: 100,
			},
		);
		const r = await ctx.run(["sleep", "5"]);
		expect(r.timedOut).toBe(true);
		expect(r.exitCode).toBe(SPAWN_FAILURE_EXIT);
	});
});
