import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUBRIC_VERSION } from "../rubric/version.ts";

/** Absolute path to the CLI entrypoint, resolved relative to this test file. */
const MAIN = join(import.meta.dir, "main.ts");

/** Spawn the CLI with `args` and capture exit code + streams. */
async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(["bun", "run", MAIN, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		// Keep stdout machine-clean even if a future default logs at info.
		env: { ...process.env, TRELLIS_LOG_LEVEL: "silent" },
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	return { code, stdout, stderr };
}

/** A broken rubric: a category with no gate criterion (loader invariant 5). */
const BROKEN = {
	"categories.yaml": "- id: documentation\n  title: Documentation\n  description: Docs.\n",
	"repo-scope.yaml":
		"- id: agents_md\n  category: documentation\n  scope: repo\n  level: 1\n  skippable: false\n  discoveryVia: deterministic\n",
	"app-scope.yaml": "[]\n",
};

describe("trellis rubric", () => {
	test("prints the version and category count on the real rubric", async () => {
		const { code, stdout } = await runCli(["rubric"]);
		expect(code).toBe(0);
		expect(stdout).toContain(`@ ${RUBRIC_VERSION}`);
		expect(stdout).toContain("90 criteria across 9 categories");
	});

	test("--json emits the full summary shape on the real rubric", async () => {
		const { code, stdout } = await runCli(["rubric", "--json"]);
		expect(code).toBe(0);
		const summary = JSON.parse(stdout);
		expect(summary.rubricVersion).toBe(RUBRIC_VERSION);
		expect(summary.categoryCount).toBe(9);
		expect(summary.criterionCount).toBe(90);
		expect(summary.categories).toHaveLength(9);
		const first = summary.categories[0];
		expect(first).toHaveProperty("id");
		expect(first).toHaveProperty("criterionCount");
		expect(first).toHaveProperty("repo");
		expect(first).toHaveProperty("app");
		expect(first.levels).toEqual(expect.objectContaining({ 1: expect.any(Number) }));
		expect(first).toHaveProperty("gate");
	});

	test("--md emits a markdown table", async () => {
		const { code, stdout } = await runCli(["rubric", "--md"]);
		expect(code).toBe(0);
		expect(stdout).toContain("# trellis rubric");
		expect(stdout).toContain("| Category | Criteria |");
	});

	test("--validate is green against the real rubric (milestone 1 gate)", async () => {
		const { code, stdout } = await runCli(["rubric", "--validate", "--json"]);
		expect(code).toBe(0);
		const result = JSON.parse(stdout);
		expect(result.valid).toBe(true);
		expect(result.criterionCount).toBe(90);
	});

	test("rejects --json and --md together", async () => {
		const { code, stderr } = await runCli(["rubric", "--json", "--md"]);
		expect(code).not.toBe(0);
		expect(stderr).toContain("at most one of --json or --md");
	});
});

describe("trellis rubric --validate on a broken fixture", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "trellis-cli-"));
		for (const [name, content] of Object.entries(BROKEN)) {
			writeFileSync(join(dir, name), content);
		}
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("exits non-zero with a precise error naming id + file", async () => {
		const { code, stdout, stderr } = await runCli(["rubric", "--validate", "--rubric-dir", dir]);
		expect(code).not.toBe(0);
		expect(stdout).toBe("");
		expect(stderr).toContain("no gate:true criterion");
		expect(stderr).toContain("documentation");
		expect(stderr).toContain("categories.yaml");
	});

	test("--json error output is machine-readable with id + file", async () => {
		const { code, stdout, stderr } = await runCli([
			"rubric",
			"--validate",
			"--json",
			"--rubric-dir",
			dir,
		]);
		expect(code).not.toBe(0);
		expect(stdout).toBe("");
		const payload = JSON.parse(stderr);
		expect(payload.error.id).toBe("documentation");
		expect(payload.error.file).toBe("categories.yaml");
		expect(payload.error.message).toContain("no gate:true criterion");
	});
});

describe("trellis (program)", () => {
	test("--version prints the package version", async () => {
		const { code, stdout } = await runCli(["--version"]);
		expect(code).toBe(0);
		expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
	});

	test("unimplemented commands exit non-zero with a stub message", async () => {
		const { code, stderr } = await runCli(["drift", join(import.meta.dir, "..")]);
		expect(code).not.toBe(0);
		expect(stderr).toContain("not yet implemented");
	});
});

describe("trellis audit", () => {
	let dir: string;

	beforeEach(() => {
		// A minimal single-app fixture — keeps detector subprocesses cheap/fast.
		dir = mkdtempSync(join(tmpdir(), "trellis-cli-audit-"));
		writeFileSync(join(dir, "README.md"), "# fixture\n");
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", main: "./i.ts" }));
		writeFileSync(join(dir, ".gitignore"), "node_modules\n");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("prints a coherent terminal scorecard", async () => {
		const { code, stdout } = await runCli(["audit", dir]);
		expect(code).toBe(0);
		expect(stdout).toContain("Level ");
		expect(stdout).toContain("pass-rate");
		expect(stdout).toContain("coverage");
		expect(stdout).toContain("measured ");
	});

	test("--json emits a parseable §6.3 report with every rubric criterion", async () => {
		const { code, stdout } = await runCli(["audit", dir, "--json"]);
		expect(code).toBe(0);
		const report = JSON.parse(stdout);
		expect(report.rubricVersion).toBe(RUBRIC_VERSION);
		expect(report.level).toBeGreaterThanOrEqual(1);
		expect(report.level).toBeLessThanOrEqual(5);
		expect(Object.keys(report.criteria)).toHaveLength(90);
		expect(report.apps).toBeDefined();
	});

	test("--md emits a markdown scorecard", async () => {
		const { code, stdout } = await runCli(["audit", dir, "--md"]);
		expect(code).toBe(0);
		expect(stdout).toContain("# Agentic-readiness scorecard");
		expect(stdout).toContain("| Category | Measured |");
	});
});
