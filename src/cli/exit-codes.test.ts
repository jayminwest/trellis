import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedFixtureRepo } from "../report/audit-fixtures.ts";

/**
 * The CLI exit-code contract (SPEC §9, §12): `0` clean, `2` when a policy
 * trips (the report is still emitted to stdout; reasons go to stderr), `1`
 * on an operational error (the command could not run). On the deterministic
 * `audit`/`fleet` surfaces the policy is declarative (`trellis.yaml`, SPEC
 * §6.5) — no policy configured means nothing to trip. The separate
 * `drift` command uses `--fail-on` for its separate drift policy.
 */

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

describe("trellis exit-code contract (SPEC §9)", () => {
	let dir: string;
	let dbDir: string;
	let dbPath: string;

	beforeEach(async () => {
		// A non-Git workspace with hotspots — a guaranteed non-zero index.
		dir = mkdtempSync(join(tmpdir(), "trellis-cli-exit-"));
		await seedFixtureRepo(dir, "sloppy");
		dbDir = mkdtempSync(join(tmpdir(), "trellis-cli-exit-db-"));
		dbPath = join(dbDir, "trellis.db");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		rmSync(dbDir, { recursive: true, force: true });
	});

	// Tests spawn the CLI as a subprocess (audit runs, reads); the 20s budget
	// accommodates slow CI containers where the 5s default is marginal.
	test("audit with no configured policy is clean (exit 0)", async () => {
		const { code, stdout } = await runCli(["audit", dir, "--json", "--quiet"], {
			TRELLIS_DB: dbPath,
		});
		expect(code).toBe(0);
		expect(JSON.parse(stdout).score.index).toBeGreaterThan(0);
	}, 20_000);

	test("a tripped declarative policy exits 2 and still emits the report", async () => {
		writeFileSync(join(dir, "trellis.yaml"), "policy:\n  maxIndex: 0\n");
		const { code, stdout, stderr } = await runCli(["audit", dir, "--json", "--quiet"], {
			TRELLIS_DB: dbPath,
		});
		expect(code).toBe(2);
		expect(JSON.parse(stdout).score.index).toBeGreaterThan(0);
		expect(stderr).toContain("policy max-index failed");
	}, 20_000);

	test("a passing declarative policy stays clean (exit 0)", async () => {
		writeFileSync(join(dir, "trellis.yaml"), "policy:\n  maxIndex: 100\n");
		const { code } = await runCli(["audit", dir, "--quiet"], { TRELLIS_DB: dbPath });
		expect(code).toBe(0);
	}, 20_000);

	test("an unreadable workspace is an operational error (exit 1), distinct from a policy trip", async () => {
		const { code, stdout, stderr } = await runCli(["audit", join(dbDir, "absent"), "--quiet"], {
			TRELLIS_DB: dbPath,
		});
		expect(code).toBe(1);
		expect(stdout).toBe("");
		expect(stderr.length).toBeGreaterThan(0);
	}, 20_000);

	test("policy failure and operational failure are always distinguishable (2 vs 1)", async () => {
		// Policy trip: report on stdout, reasons on stderr, exit 2.
		writeFileSync(join(dir, "trellis.yaml"), "policy:\n  maxIndex: 0\n");
		const tripped = await runCli(["audit", dir, "--json", "--quiet"], { TRELLIS_DB: dbPath });
		expect(tripped.code).toBe(2);
		expect(tripped.stdout.length).toBeGreaterThan(0);
		// Operational: nothing on stdout, exit 1.
		const broken = await runCli(
			["audit", dir, "--json", "--quiet", "--config", join(dbDir, "gone.yaml")],
			{
				TRELLIS_DB: dbPath,
			},
		);
		expect(broken.code).toBe(1);
		expect(broken.stdout).toBe("");
	}, 20_000);

	test("drift defaults to failing when drift is detected (exit 2)", async () => {
		const { code, stderr } = await runCli(["drift", dir]);
		expect(code).toBe(2);
		expect(stderr).toContain("canonical drift detected");
	}, 20_000);

	test("drift --fail-on none exits 0 despite drift", async () => {
		const { code } = await runCli(["drift", dir, "--fail-on", "none"]);
		expect(code).toBe(0);
	}, 20_000);

	test("a fleet with an unauditable target trips exit 2 with the report still emitted", async () => {
		const targets = join(dbDir, "targets.yaml");
		writeFileSync(
			targets,
			`targets:\n  - id: fixture\n    path: ${dir}\n` +
				`  - id: gone\n    path: ${join(dbDir, "missing")}\n`,
		);
		const fail = await runCli(["fleet", "--targets", targets], { TRELLIS_DB: "" });
		expect(fail.code).toBe(2);
		expect(fail.stdout).toContain("trellis fleet");
		expect(fail.stderr).toContain("gone");
	}, 20_000);

	test("a fleet whose target trips its declarative policy exits 2, distinct from an operational error", async () => {
		writeFileSync(join(dir, "trellis.yaml"), "policy:\n  maxIndex: 0\n");
		const targets = join(dbDir, "targets.yaml");
		writeFileSync(targets, `targets:\n  - id: fixture\n    path: ${dir}\n`);
		const tripped = await runCli(["fleet", "--targets", targets], { TRELLIS_DB: "" });
		expect(tripped.code).toBe(2);
		expect(tripped.stdout).toContain("trellis fleet");
		expect(tripped.stderr).toContain("fixture: policy failed");
		// Operational: the fleet declaration itself is broken — nothing on stdout, exit 1.
		const broken = await runCli(["fleet", "--targets", join(dbDir, "absent.yaml")], {
			TRELLIS_DB: "",
		});
		expect(broken.code).toBe(1);
		expect(broken.stdout).toBe("");
	}, 20_000);
});
