import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedFixtureRepo } from "../report/audit-fixtures.ts";

/**
 * `trellis audit` on the deterministic core (SPEC §12, trellis-9a88). The
 * default run is stateless — no database, no report files — and prints the
 * sloppiness report in the caller's format; `--out` writes an artifact,
 * `--history` opts into persistence, `--baseline`/`--config` drive the
 * declarative policy (exit 2, report still emitted), and retired
 * readiness/investigation flags fail fast with actionable errors (exit 1).
 * Every fixture is a real non-Git temp workspace seeded through the shared
 * render fixtures; progress goes to stderr so stdout stays machine-clean.
 */

const MAIN = join(import.meta.dir, "main.ts");

async function runCli(
	args: string[],
	env: Record<string, string> = {},
	opts: { cwd?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(["bun", "run", MAIN, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		...(opts.cwd ? { cwd: opts.cwd } : {}),
		env: { ...process.env, TRELLIS_LOG_LEVEL: "silent", ...env },
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	return { code, stdout, stderr };
}

describe("trellis audit (deterministic core)", () => {
	let dir: string;
	let dbDir: string;
	let dbPath: string;

	beforeEach(async () => {
		// A non-Git workspace with hotspots — no credentials or project tools needed.
		dir = mkdtempSync(join(tmpdir(), "trellis-cli-audit-"));
		await seedFixtureRepo(dir, "sloppy");
		// A central DB location outside the audited repo, so tests never touch ~/.trellis.
		dbDir = mkdtempSync(join(tmpdir(), "trellis-cli-db-"));
		dbPath = join(dbDir, "trellis.db");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		rmSync(dbDir, { recursive: true, force: true });
	});

	// Tests spawn the CLI as a subprocess (audit runs, reads); the 20s budget
	// accommodates slow CI containers where the 5s default is marginal.
	test("prints the terminal sloppiness report with direction and scoring version", async () => {
		const { code, stdout } = await runCli(["audit", dir, "--quiet"], { TRELLIS_DB: dbPath });
		expect(code).toBe(0);
		expect(stdout).toContain("sloppiness index");
		expect(stdout).toContain("/100 · lower is better · scoring");
		expect(stdout).toContain("completeness:");
		expect(stdout).toContain("source coverage");
	}, 20_000);

	test("--json emits a parseable §6.4 report", async () => {
		const { code, stdout } = await runCli(["audit", dir, "--json", "--quiet"], {
			TRELLIS_DB: dbPath,
		});
		expect(code).toBe(0);
		const report = JSON.parse(stdout);
		expect(report.schemaVersion).toBeDefined();
		expect(report.analyzerVersion).toBeDefined();
		expect(report.scoringVersion).toBeDefined();
		expect(report.score.index).toBeGreaterThan(0);
		expect(report.score.direction).toBe("lower-is-better");
		expect(Object.keys(report.metrics).length).toBeGreaterThan(0);
		expect(Array.isArray(report.findings)).toBe(true);
	}, 20_000);

	test("--md emits a markdown summary", async () => {
		const { code, stdout } = await runCli(["audit", dir, "--md", "--quiet"], {
			TRELLIS_DB: dbPath,
		});
		expect(code).toBe(0);
		expect(stdout).toContain("# trellis audit");
		expect(stdout).toContain("lower is better");
	}, 20_000);

	test("the default run is stateless: no database, no report files (SPEC §8, §10)", async () => {
		const { code } = await runCli(["audit", dir, "--quiet"], { TRELLIS_DB: dbPath }, { cwd: dir });
		expect(code).toBe(0);
		expect(existsSync(dbPath)).toBe(false);
		expect(existsSync(join(dir, ".trellis"))).toBe(false);
	}, 20_000);

	test("writes a JSON artifact without stdout when --out is supplied", async () => {
		const out = join(dbDir, "report.json");
		// No --quiet: the write notice lands on stderr (progress stays silent off-TTY).
		const { code, stdout, stderr } = await runCli(["audit", dir, "--out", out], {
			TRELLIS_DB: dbPath,
		});
		expect(code).toBe(0);
		expect(existsSync(out)).toBe(true);
		const parsed = JSON.parse(readFileSync(out, "utf8"));
		expect(parsed.score.index).toBeGreaterThan(0);
		expect(stdout).toBe("");
		expect(stderr).toContain("report written to");
	}, 20_000);

	test("--md overrides a .json extension for the --out artifact", async () => {
		const out = join(dbDir, "report.json");
		const { code, stdout } = await runCli(["audit", dir, "--quiet", "--md", "--out", out], {
			TRELLIS_DB: dbPath,
		});
		expect(code).toBe(0);
		expect(readFileSync(out, "utf8").startsWith("#")).toBe(true);
		expect(stdout).toBe("");
	}, 20_000);

	test.each([
		false,
		true,
	])("writes --json --out relative to cwd with policy failure %s", async (failed) => {
		if (failed) writeFileSync(join(dir, "trellis.yaml"), "policy:\n  maxIndex: 0\n");
		const { code, stdout, stderr } = await runCli(
			["audit", ".", "--json", "--out", "report.json"],
			{ TRELLIS_DB: dbPath },
			{ cwd: dir },
		);
		expect(code).toBe(failed ? 2 : 0);
		expect(stdout).toBe("");
		const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
		expect(report.schemaVersion).toBeDefined();
		expect(report.score.index).toBeGreaterThan(0);
		expect(stderr).toContain("report written to report.json");
		if (failed) expect(stderr).toContain("policy max-index failed");
	}, 20_000);

	test("a bad --out target fails fast before the audit runs (exit 1)", async () => {
		const missing = join(dbDir, "no-such-dir", "report.json");
		const { code, stdout, stderr } = await runCli(["audit", dir, "--out", missing], {
			TRELLIS_DB: dbPath,
		});
		expect(code).toBe(1);
		expect(stderr).toContain("could not write report to");
		expect(stdout).toBe("");
	}, 20_000);

	test("--history persists the run and resolves the stored baseline next time", async () => {
		const first = await runCli(["audit", dir, "--quiet", "--history", "--db", dbPath], {
			TRELLIS_DB: "",
		});
		expect(first.code).toBe(0);
		expect(existsSync(dbPath)).toBe(true);
		const second = await runCli(["audit", dir, "--quiet", "--history", "--db", dbPath], {
			TRELLIS_DB: "",
		});
		expect(second.code).toBe(0);
		const { openStore } = await import("../store/index.ts");
		const store = openStore(dbPath);
		try {
			const repos = store.auditRepos();
			expect(repos).toHaveLength(1);
			expect(store.auditRuns(repos[0] ?? "")).toHaveLength(2);
		} finally {
			store.close();
		}
	}, 20_000);

	test("--db without --history is an operational error (exit 1)", async () => {
		const { code, stdout, stderr } = await runCli(["audit", dir, "--db", dbPath], {
			TRELLIS_DB: "",
		});
		expect(code).toBe(1);
		expect(stdout).toBe("");
		expect(stderr).toContain("--history");
	}, 20_000);

	test("a tripped maxIndex policy exits 2 with the report on stdout and reasons on stderr", async () => {
		writeFileSync(join(dir, "trellis.yaml"), "policy:\n  maxIndex: 0\n");
		const { code, stdout, stderr } = await runCli(["audit", dir, "--json", "--quiet"], {
			TRELLIS_DB: dbPath,
		});
		expect(code).toBe(2);
		// The report is still emitted — the policy trips after the run.
		expect(JSON.parse(stdout).score.index).toBeGreaterThan(0);
		expect(stderr).toContain("policy max-index failed");
		expect(stderr).toContain("exceeds the configured maximum");
	}, 20_000);

	test("--baseline with a zero-tolerance regression policy trips on a sloppier run", async () => {
		// Baseline the workspace clean, then re-seed it sloppy.
		rmSync(dir, { recursive: true, force: true });
		dir = mkdtempSync(join(tmpdir(), "trellis-cli-audit-"));
		await seedFixtureRepo(dir, "clean");
		const baselineRun = await runCli(["audit", dir, "--json", "--quiet"], { TRELLIS_DB: dbPath });
		expect(baselineRun.code).toBe(0);
		const baselinePath = join(dbDir, "baseline.json");
		writeFileSync(baselinePath, baselineRun.stdout);
		await seedFixtureRepo(dir, "sloppy");
		const configPath = join(dbDir, "trellis.yaml");
		writeFileSync(configPath, "policy:\n  regression: {}\n");
		const { code, stdout, stderr } = await runCli(
			["audit", dir, "--json", "--quiet", "--baseline", baselinePath, "--config", configPath],
			{ TRELLIS_DB: dbPath },
		);
		expect(code).toBe(2);
		expect(JSON.parse(stdout).score.index).toBeGreaterThan(0);
		expect(stderr).toContain("policy score-regression failed");
	}, 20_000);

	test("an unloadable --baseline artifact is operational (exit 1), never a policy failure", async () => {
		const { code, stdout, stderr } = await runCli(
			["audit", dir, "--quiet", "--baseline", join(dbDir, "absent.json")],
			{ TRELLIS_DB: dbPath },
		);
		expect(code).toBe(1);
		expect(stdout).toBe("");
		expect(stderr).toContain("cannot read report artifact");
	}, 20_000);

	test("an invalid --config file is an operational error naming the key (exit 1)", async () => {
		const configPath = join(dbDir, "trellis.yaml");
		writeFileSync(configPath, "policy:\n  maxIndex: 400\n");
		const { code, stdout, stderr } = await runCli(
			["audit", dir, "--quiet", "--config", configPath],
			{ TRELLIS_DB: dbPath },
		);
		expect(code).toBe(1);
		expect(stdout).toBe("");
		expect(stderr).toContain("policy.maxIndex");
	}, 20_000);

	test("--verbose progress goes to stderr, leaving stdout JSON parseable", async () => {
		const { code, stdout, stderr } = await runCli(["audit", dir, "--json", "--verbose"], {
			TRELLIS_DB: dbPath,
		});
		expect(code).toBe(0);
		expect(() => JSON.parse(stdout)).not.toThrow();
		expect(stderr).toContain("trellis:");
		expect(stderr).toContain("measuring");
	}, 20_000);

	test("--quiet emits no progress on stderr", async () => {
		const { code, stderr } = await runCli(["audit", dir, "--quiet"], { TRELLIS_DB: dbPath });
		expect(code).toBe(0);
		expect(stderr).toBe("");
	}, 20_000);

	test("help text describes the new surface and hides retired flags", async () => {
		const { code, stdout } = await runCli(["audit", "--help"]);
		expect(code).toBe(0);
		for (const flag of ["--out", "--baseline", "--config", "--history", "--quiet", "--verbose"]) {
			expect(stdout).toContain(flag);
		}
		for (const retired of [
			"--fail-on",
			"--min-level",
			"--rubric-version",
			"--output",
			"--no-persist",
		]) {
			expect(stdout).not.toContain(retired);
		}
	}, 20_000);
});

describe("trellis audit retired flags (SPEC §14)", () => {
	let dir: string;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "trellis-cli-retired-"));
		await seedFixtureRepo(dir, "clean");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("--no-cache is rejected with an actionable retirement message", async () => {
		const { code, stdout, stderr } = await runCli(["audit", dir, "--no-cache", "--quiet"]);
		expect(code).toBe(1);
		expect(stdout).toBe("");
		expect(stderr).toContain("--no-cache no longer exists");
		expect(stderr).toContain("Remove --no-cache");
	}, 20_000);

	test("TRELLIS_PI_BIN is rejected with an actionable retirement message", async () => {
		const { code, stdout, stderr } = await runCli(["audit", dir, "--quiet"], {
			TRELLIS_PI_BIN: "/usr/local/bin/pi",
		});
		expect(code).toBe(1);
		expect(stdout).toBe("");
		expect(stderr).toContain("TRELLIS_PI_BIN no longer exists");
	}, 20_000);

	test("--no-persist explains audits are stateless by default now", async () => {
		const { code, stderr } = await runCli(["audit", dir, "--no-persist", "--quiet"]);
		expect(code).toBe(1);
		expect(stderr).toContain("--no-persist no longer exists");
		expect(stderr).toContain("--history");
	}, 20_000);

	test("--output points at --out", async () => {
		const { code, stderr } = await runCli(["audit", dir, "--output", "r.md", "--quiet"]);
		expect(code).toBe(1);
		expect(stderr).toContain("--output/--no-output no longer exist");
		expect(stderr).toContain("--out");
	}, 20_000);

	test("--fail-on and --min-level point at the declarative policy", async () => {
		const failOn = await runCli(["audit", dir, "--fail-on", "none", "--quiet"]);
		expect(failOn.code).toBe(1);
		expect(failOn.stderr).toContain("--fail-on no longer exists");
		expect(failOn.stderr).toContain("trellis.yaml");
		const minLevel = await runCli(["audit", dir, "--min-level", "3", "--quiet"]);
		expect(minLevel.code).toBe(1);
		expect(minLevel.stderr).toContain("--min-level no longer exists");
	}, 20_000);

	test("--rubric-version and --canonical name the pivot", async () => {
		const rubric = await runCli(["audit", dir, "--rubric-version", "1.0.0", "--quiet"]);
		expect(rubric.code).toBe(1);
		expect(rubric.stderr).toContain("--rubric-version no longer exists");
		const canonical = await runCli(["audit", dir, "--canonical", "1.0.0", "--quiet"]);
		expect(canonical.code).toBe(1);
		expect(canonical.stderr).toContain("--canonical no longer exists");
		expect(canonical.stderr).toContain("trellis drift");
	}, 20_000);
});
