import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedFixtureRepo } from "../report/audit-fixtures.ts";

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

	beforeEach(async () => {
		// One real TS fixture repo, plus a declared-but-missing target.
		repoDir = mkdtempSync(join(tmpdir(), "trellis-fleet-repo-"));
		await seedFixtureRepo(repoDir, "clean");

		workDir = mkdtempSync(join(tmpdir(), "trellis-fleet-work-"));
		dbPath = join(workDir, "trellis.db");
		targetsFile = join(workDir, "targets.yaml");
		writeFileSync(
			targetsFile,
			`targets:\n  - id: fixture\n    path: ${repoDir}\n` +
				`  - id: gone\n    path: ${join(workDir, "does-not-exist")}\n`,
		);
	});

	afterEach(() => {
		rmSync(repoDir, { recursive: true, force: true });
		rmSync(workDir, { recursive: true, force: true });
	});

	// Tests spawn the CLI as a subprocess (audit runs, reads); the 20s budget
	// accommodates slow CI containers where the 5s default is marginal.
	test("audits every target and isolates a missing path (exit 2, report still emitted)", async () => {
		const { code, stdout, stderr } = await runCli(["fleet", "--targets", targetsFile], {
			TRELLIS_DB: "",
		});
		expect(code).toBe(2);
		expect(stdout).toContain("trellis fleet");
		expect(stdout).toContain("lower is better");
		expect(stdout).toContain("fixture");
		expect(stdout).toContain("1 ok · 1 error · 0 policy failed");
		expect(stdout).toContain("error: path not found");
		expect(stderr).toContain("gone");
	}, 20_000);

	test("a fleet of healthy targets is clean (exit 0)", async () => {
		writeFileSync(targetsFile, `targets:\n  - id: fixture\n    path: ${repoDir}\n`);
		const { code, stdout } = await runCli(["fleet", "--targets", targetsFile], { TRELLIS_DB: "" });
		expect(code).toBe(0);
		expect(stdout).toContain("1 ok · 0 error · 0 policy failed");
	}, 20_000);

	test("a target's tripped declarative policy exits 2 with the reason on stderr", async () => {
		// A sloppy repo has a non-zero index, so maxIndex: 0 trips.
		const sloppyDir = mkdtempSync(join(tmpdir(), "trellis-fleet-sloppy-"));
		await seedFixtureRepo(sloppyDir, "sloppy");
		writeFileSync(join(sloppyDir, "trellis.yaml"), "policy:\n  maxIndex: 0\n");
		writeFileSync(targetsFile, `targets:\n  - id: fixture\n    path: ${sloppyDir}\n`);
		const { code, stdout, stderr } = await runCli(["fleet", "--targets", targetsFile], {
			TRELLIS_DB: "",
		});
		rmSync(sloppyDir, { recursive: true, force: true });
		expect(code).toBe(2);
		// The target audited fine — its declarative policy tripped.
		expect(stdout).toContain("1 ok · 0 error · 1 policy failed");
		expect(stderr).toContain("fixture: policy failed");
		expect(stderr).toContain("exceeds the configured maximum");
	}, 20_000);

	test("--json emits the aggregate report with per-target entries", async () => {
		const { code, stdout } = await runCli(["fleet", "--targets", targetsFile, "--json"], {
			TRELLIS_DB: "",
		});
		expect(code).toBe(2); // the missing target still trips the exit rollup
		const report = JSON.parse(stdout);
		expect(report.summary).toEqual({ ok: 1, error: 1, policyFailed: 0 });
		const fixture = report.entries.find((e: { id: string }) => e.id === "fixture");
		expect(fixture.ok).toBe(true);
		// The entry preserves the full §6.4 report and the non-scoring drift counts.
		expect(fixture.report.score.direction).toBe("lower-is-better");
		expect(fixture.drift.missing).toBeGreaterThan(0);
		expect(fixture.previousIndex).toBeNull();
	}, 20_000);

	test("--history persists one audit run per scored target", async () => {
		const { code } = await runCli(
			["fleet", "--targets", targetsFile, "--history", "--db", dbPath],
			{ TRELLIS_DB: "" },
		);
		expect(code).toBe(2);
		const { openStore } = await import("../store/index.ts");
		const store = openStore(dbPath);
		try {
			// The scored target persists under its workspace identity; the missing one does not.
			expect(store.auditRepos()).toHaveLength(1);
		} finally {
			store.close();
		}
	}, 20_000);

	test("is stateless by default — no database is created", async () => {
		await runCli(["fleet", "--targets", targetsFile], { TRELLIS_DB: dbPath });
		const { existsSync } = await import("node:fs");
		expect(existsSync(dbPath)).toBe(false);
	}, 20_000);

	test("errors clearly on a malformed targets.yaml", async () => {
		writeFileSync(targetsFile, "targets:\n  - id: a\n"); // missing required `path`
		const { code, stderr } = await runCli(["fleet", "--targets", targetsFile], { TRELLIS_DB: "" });
		expect(code).toBe(1);
		expect(stderr).toContain("targets.yaml");
	}, 20_000);
});
