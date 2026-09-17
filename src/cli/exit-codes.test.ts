import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedFixtureRepo } from "../report/audit-fixtures.ts";

/**
 * The CLI exit-code contract (SPEC §9, §12): `0` clean, `2` when a policy
 * trips (the report is still emitted to stdout; reasons go to stderr), `1`
 * on an operational error (the command could not run). On the deterministic
 * `audit` surface the policy is declarative (`trellis.yaml`, SPEC §6.5) — no
 * policy configured means nothing to trip. The transitional `drift`/`fleet`
 * commands keep their legacy `--fail-on` knobs until trellis-8366.
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

	test("audit with no configured policy is clean (exit 0)", async () => {
		const { code, stdout } = await runCli(["audit", dir, "--json", "--quiet"], {
			TRELLIS_DB: dbPath,
		});
		expect(code).toBe(0);
		expect(JSON.parse(stdout).score.index).toBeGreaterThan(0);
	});

	test("a tripped declarative policy exits 2 and still emits the report", async () => {
		writeFileSync(join(dir, "trellis.yaml"), "policy:\n  maxIndex: 0\n");
		const { code, stdout, stderr } = await runCli(["audit", dir, "--json", "--quiet"], {
			TRELLIS_DB: dbPath,
		});
		expect(code).toBe(2);
		expect(JSON.parse(stdout).score.index).toBeGreaterThan(0);
		expect(stderr).toContain("policy max-index failed");
	});

	test("a passing declarative policy stays clean (exit 0)", async () => {
		writeFileSync(join(dir, "trellis.yaml"), "policy:\n  maxIndex: 100\n");
		const { code } = await runCli(["audit", dir, "--quiet"], { TRELLIS_DB: dbPath });
		expect(code).toBe(0);
	});

	test("an unreadable workspace is an operational error (exit 1), distinct from a policy trip", async () => {
		const { code, stdout, stderr } = await runCli(["audit", join(dbDir, "absent"), "--quiet"], {
			TRELLIS_DB: dbPath,
		});
		expect(code).toBe(1);
		expect(stdout).toBe("");
		expect(stderr.length).toBeGreaterThan(0);
	});

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
	});

	test("drift defaults to failing when drift is detected (exit 2)", async () => {
		const { code, stderr } = await runCli(["drift", dir]);
		expect(code).toBe(2);
		expect(stderr).toContain("canonical drift detected");
	});

	test("drift --fail-on none exits 0 despite drift", async () => {
		const { code } = await runCli(["drift", dir, "--fail-on", "none"]);
		expect(code).toBe(0);
	});

	test("a fleet with an unauditable target trips a non-zero exit by default", async () => {
		const targets = join(dbDir, "targets.yaml");
		writeFileSync(
			targets,
			`targets:\n  - id: fixture\n    path: ${dir}\n    languages: [typescript]\n` +
				`  - id: gone\n    path: ${join(dbDir, "missing")}\n`,
		);
		const fail = await runCli(["fleet", "--targets", targets, "--db", dbPath], {
			TRELLIS_DB: "",
		});
		expect(fail.code).toBe(2);
		expect(fail.stderr).toContain("gone");
		const clean = await runCli(
			["fleet", "--targets", targets, "--db", dbPath, "--fail-on", "none"],
			{
				TRELLIS_DB: "",
			},
		);
		expect(clean.code).toBe(0);
	});
});
