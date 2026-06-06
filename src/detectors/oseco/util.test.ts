import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDetectionContext } from "../context.ts";
import type { DetectionContext } from "../types.ts";
import { ciInvokes, dirPresent, hasAgentTrailers, scriptMatching } from "./util.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function repo(
	files: Record<string, string>,
): Promise<{ ctx: DetectionContext; root: string }> {
	const root = await mkdtemp(join(tmpdir(), "trellis-oseco-util-"));
	dirs.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(root, rel);
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, content);
	}
	return { ctx: createDetectionContext(root, { path: ".", languages: ["typescript"] }), root };
}

describe("dirPresent", () => {
	test("true when a dir holds a dotfile-nested record, false when absent", async () => {
		const { ctx } = await repo({ ".mulch/records/x.json": "{}" });
		expect(await dirPresent(ctx, ".mulch")).toBe(true);
		expect(await dirPresent(ctx, ".plot")).toBe(false);
	});
});

describe("scriptMatching", () => {
	test("matches by script name and by command, null otherwise", async () => {
		const { ctx } = await repo({
			"package.json": JSON.stringify({ scripts: { "check:all": "bun run x", build: "tsc" } }),
		});
		expect((await scriptMatching(ctx, /^check:all$/))?.name).toBe("check:all");
		expect((await scriptMatching(ctx, /tsc/))?.name).toBe("build");
		expect(await scriptMatching(ctx, /nope/)).toBeNull();
	});
});

describe("ciInvokes", () => {
	test("true when a workflow runs the gate, false otherwise", async () => {
		const { ctx } = await repo({
			".github/workflows/ci.yml": "jobs:\n  c:\n    steps:\n      - run: bun run check:all\n",
		});
		expect(await ciInvokes(ctx, /check:all/)).toBe(true);
		expect(await ciInvokes(ctx, /deploy:prod/)).toBe(false);
	});
});

describe("hasAgentTrailers", () => {
	test("detects a Co-authored-by agent trailer in git history", async () => {
		const { ctx, root } = await repo({ "a.txt": "x" });
		const run = (argv: string[]) => ctx.run(argv, { cwd: root });
		await run(["git", "init"]);
		await run(["git", "config", "user.email", "dev@example.com"]);
		await run(["git", "config", "user.name", "Dev"]);
		await run(["git", "add", "-A"]);
		await run([
			"git",
			"commit",
			"-m",
			"feat: thing\n\nCo-authored-by: factory-droid[bot] <bot@factory.ai>",
		]);
		expect(await hasAgentTrailers(ctx)).toBe(true);
	});

	test("false for a non-git checkout", async () => {
		const { ctx } = await repo({ "a.txt": "x" });
		expect(await hasAgentTrailers(ctx)).toBe(false);
	});
});
