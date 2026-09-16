import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUBRIC_VERSION } from "../rubric/version.ts";

/** Absolute path to the CLI entrypoint, resolved relative to this test file. */
const MAIN = join(import.meta.dir, "main.ts");

/** Spawn the CLI with `args` and capture exit code + streams. */
async function runCli(
	args: string[],
	env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(["bun", "run", MAIN, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, TRELLIS_LOG_LEVEL: "silent", ...env },
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	return { code, stdout, stderr };
}

describe("trellis fleet", () => {
	let repoDir: string;
	let workDir: string;
	let dbPath: string;
	let targetsFile: string;

	beforeEach(() => {
		// One real single-app fixture repo, plus a declared-but-missing target.
		repoDir = mkdtempSync(join(tmpdir(), "trellis-fleet-repo-"));
		writeFileSync(join(repoDir, "README.md"), "# fixture\n");
		writeFileSync(
			join(repoDir, "package.json"),
			JSON.stringify({ name: "fixture", main: "./i.ts" }),
		);
		writeFileSync(join(repoDir, ".gitignore"), "node_modules\n");

		workDir = mkdtempSync(join(tmpdir(), "trellis-fleet-work-"));
		dbPath = join(workDir, "trellis.db");
		targetsFile = join(workDir, "targets.yaml");
		writeFileSync(
			targetsFile,
			`defaults:\n  canonicalVersion: "1.0.0"\ntargets:\n` +
				`  - id: fixture\n    path: ${repoDir}\n    languages: [typescript]\n` +
				`  - id: gone\n    path: ${join(workDir, "does-not-exist")}\n`,
		);
	});

	afterEach(() => {
		rmSync(repoDir, { recursive: true, force: true });
		rmSync(workDir, { recursive: true, force: true });
	});

	test("audits every target, isolates a missing path, and persists each scored run", async () => {
		const { code, stdout } = await runCli(
			["fleet", "--targets", targetsFile, "--db", dbPath, "--fail-on", "none"],
			{
				TRELLIS_DB: "",
			},
		);
		expect(code).toBe(0);
		expect(stdout).toContain("trellis fleet");
		expect(stdout).toContain("fixture");
		expect(stdout).toContain("1 ok · 1 error");
		expect(stdout).toContain("error: path not found");

		const { openStore } = await import("../store/index.ts");
		const store = openStore(dbPath);
		try {
			// The scored target persists under its targets.yaml id (not the path basename).
			expect(store.latestRun("fixture")).not.toBeNull();
			expect(store.latestRun("gone")).toBeNull();
		} finally {
			store.close();
		}
	});

	test("--json emits the aggregate report with per-target entries", async () => {
		const { code, stdout } = await runCli(
			["fleet", "--targets", targetsFile, "--db", dbPath, "--json", "--fail-on", "none"],
			{ TRELLIS_DB: "" },
		);
		expect(code).toBe(0);
		const report = JSON.parse(stdout);
		expect(report.rubricVersion).toBe(RUBRIC_VERSION);
		expect(report.summary).toEqual({ ok: 1, error: 1 });
		const fixture = report.entries.find((e: { id: string }) => e.id === "fixture");
		expect(fixture.ok).toBe(true);
		// The entry carries the per-state drift counts (the report's drift summary).
		expect(fixture.drift.missing).toBeGreaterThan(0);
		expect(fixture.previousLevel).toBeNull();
	});

	test("errors clearly on a malformed targets.yaml", async () => {
		writeFileSync(targetsFile, "targets:\n  - id: a\n"); // missing required `path`
		const { code, stderr } = await runCli(["fleet", "--targets", targetsFile, "--db", dbPath], {
			TRELLIS_DB: "",
		});
		expect(code).not.toBe(0);
		expect(stderr).toContain("targets.yaml");
	});

	test("rejects a targets.yaml with retired defaults.investigation, actionably", async () => {
		writeFileSync(
			targetsFile,
			`defaults:\n  investigation:\n    provider: anthropic\n    model: claude-opus-4-8\n` +
				`targets:\n  - id: fixture\n    path: ${repoDir}\n`,
		);
		const { code, stdout, stderr } = await runCli(
			["fleet", "--targets", targetsFile, "--db", dbPath, "--fail-on", "none"],
			{ TRELLIS_DB: "" },
		);
		expect(code).toBe(1);
		expect(stdout).toBe("");
		expect(stderr).toContain("defaults.investigation");
		expect(stderr).toContain("no longer exists");
		expect(stderr).toContain("Remove defaults.investigation");
	});

	test("--no-cache is rejected with an actionable retirement message", async () => {
		const { code, stdout, stderr } = await runCli(
			["fleet", "--targets", targetsFile, "--db", dbPath, "--no-cache"],
			{ TRELLIS_DB: "" },
		);
		expect(code).toBe(1);
		expect(stdout).toBe("");
		expect(stderr).toContain("--no-cache no longer exists");
		expect(stderr).toContain("Remove --no-cache");
	});

	test("TRELLIS_PI_BIN is rejected with an actionable retirement message", async () => {
		const { code, stdout, stderr } = await runCli(
			["fleet", "--targets", targetsFile, "--db", dbPath, "--fail-on", "none"],
			{ TRELLIS_DB: "", TRELLIS_PI_BIN: "/usr/local/bin/pi" },
		);
		expect(code).toBe(1);
		expect(stdout).toBe("");
		expect(stderr).toContain("TRELLIS_PI_BIN no longer exists");
	});
});
