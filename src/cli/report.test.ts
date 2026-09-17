import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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

describe("trellis report", () => {
	let repoDir: string;
	let workDir: string;
	let dbPath: string;

	beforeEach(async () => {
		repoDir = mkdtempSync(join(tmpdir(), "trellis-report-repo-"));
		await seedFixtureRepo(repoDir, "sloppy");
		workDir = mkdtempSync(join(tmpdir(), "trellis-report-work-"));
		dbPath = join(workDir, "trellis.db");
	});

	afterEach(() => {
		rmSync(repoDir, { recursive: true, force: true });
		rmSync(workDir, { recursive: true, force: true });
	});

	/** Record one audit run of the fixture into the central history. */
	async function auditRun(): Promise<void> {
		const { code } = await runCli(["audit", repoDir, "--history", "--db", dbPath, "--quiet"], {
			TRELLIS_DB: "",
		});
		expect(code).toBe(0);
	}

	// Each test spawns the CLI 1-3 times (audit runs + report reads); the 20s
	// budget accommodates slow CI containers where the 5s default is marginal.
	test("reports an empty dashboard on a store with no runs", async () => {
		const { code, stdout } = await runCli(["report", "--db", dbPath, "--json"], { TRELLIS_DB: "" });
		expect(code).toBe(0);
		const report = JSON.parse(stdout);
		expect(report.audits.snapshot).toEqual([]);
		expect(report.audits.repos).toEqual([]);
		expect(report.legacy).toEqual([]);
	}, 20_000);

	test("after two recorded audits, shows the snapshot and the compatible series", async () => {
		await auditRun();
		await auditRun();

		const { code, stdout } = await runCli(["report", "--db", dbPath, "--json"], { TRELLIS_DB: "" });
		expect(code).toBe(0);
		const report = JSON.parse(stdout);

		expect(report.audits.snapshot).toHaveLength(1);
		const entry = report.audits.snapshot[0];
		expect(entry.repo).toContain("fixture-sloppy#");
		expect(entry.runs).toBe(2);
		// Same workspace, unchanged ⇒ the index move is exactly zero.
		expect(entry.indexDelta).toBe(0);
		expect(entry.index).toBeGreaterThan(0);

		const detail = report.audits.repos[0];
		expect(detail.runs).toHaveLength(2);
		expect(detail.runs[0].index).toBe(entry.index);
	}, 20_000);

	test("the --repo filter narrows the dashboard to one identity", async () => {
		await auditRun();
		const full = JSON.parse(
			(await runCli(["report", "--db", dbPath, "--json"], { TRELLIS_DB: "" })).stdout,
		);
		const identity = full.audits.snapshot[0].repo;
		const { code, stdout } = await runCli(
			["report", "--repo", identity, "--db", dbPath, "--json"],
			{ TRELLIS_DB: "" },
		);
		expect(code).toBe(0);
		const report = JSON.parse(stdout);
		expect(report.scope.repo).toBe(identity);
		expect(report.audits.snapshot.map((e: { repo: string }) => e.repo)).toEqual([identity]);
	}, 20_000);

	test("legacy readiness runs surface in a visibly distinct section", async () => {
		await auditRun();
		// Seed a legacy readiness run directly into the same database.
		const { openStore } = await import("../store/index.ts");
		const store = openStore(dbPath);
		try {
			store.insertRun({
				repo: "warren",
				rubricVersion: "1.0.0",
				scoredAt: "2026-05-01T00:00:00.000Z",
				commit: "c0",
				level: 3,
				passRate: 0.75,
				coverage: 0.9,
				apps: { ".": { description: "warren" } },
				criteria: { a: { numerator: 1, denominator: 1, rationale: "x" } },
			});
		} finally {
			store.close();
		}

		const { code, stdout } = await runCli(["report", "--db", dbPath], { TRELLIS_DB: "" });
		expect(code).toBe(0);
		expect(stdout).toContain("sloppiness snapshot");
		expect(stdout).toContain("legacy readiness history");
		expect(stdout).toContain("never compared with the sloppiness index");
		expect(stdout).toContain("warren");
		expect(stdout).toContain("L3");
	}, 20_000);

	test("renders the human dashboard with the snapshot table after a run", async () => {
		await auditRun();
		const { code, stdout } = await runCli(["report", "--db", dbPath], { TRELLIS_DB: "" });
		expect(code).toBe(0);
		expect(stdout).toContain("trellis report · sloppiness history");
		expect(stdout).toContain("lower is better");
		expect(stdout).toContain("fixture-sloppy#");
	}, 20_000);
});
