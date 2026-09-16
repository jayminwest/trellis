import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The CLI exit-code contract (SPEC §12): `0` clean, `2` when a `--fail-on`
 * policy trips (the report is still emitted), `1` on an operational error. The
 * default policy (no `--fail-on`) fails on a gate criterion OR canonical drift.
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

describe("trellis exit-code contract (--fail-on, SPEC §12)", () => {
	let dir: string;
	let dbDir: string;
	let dbPath: string;

	beforeEach(() => {
		// A minimal fixture: real but sparse, so deterministic gate criteria fail.
		dir = mkdtempSync(join(tmpdir(), "trellis-cli-exit-"));
		writeFileSync(join(dir, "README.md"), "# fixture\n");
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", main: "./i.ts" }));
		writeFileSync(join(dir, ".gitignore"), "node_modules\n");
		dbDir = mkdtempSync(join(tmpdir(), "trellis-cli-exit-db-"));
		dbPath = join(dbDir, "trellis.db");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		rmSync(dbDir, { recursive: true, force: true });
	});

	/** Run `trellis audit` with the shared env + extra args. */
	function auditCli(extra: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
		// `--no-output`: these assert exit codes, not artifacts — never write a report file.
		return runCli(["audit", dir, "--db", dbPath, "--no-persist", "--no-output", ...extra], {
			TRELLIS_DB: "",
		});
	}

	test("audit defaults to failing on a gate criterion (exit 2), still emitting the report", async () => {
		const { code, stdout, stderr } = await auditCli(["--json"]);
		expect(code).toBe(2);
		// The full report is still on stdout — the policy trips *after* emitting.
		expect(Object.keys(JSON.parse(stdout).criteria)).toHaveLength(70);
		expect(stderr).toContain("gate criterion failed");
	});

	test("--fail-on none always exits 0", async () => {
		const { code } = await auditCli(["--fail-on", "none"]);
		expect(code).toBe(0);
	});

	test("--fail-on gate trips on a failing gate (exit 2)", async () => {
		const { code, stderr } = await auditCli(["--fail-on", "gate"]);
		expect(code).toBe(2);
		expect(stderr).toContain("gate criterion failed");
	});

	test("--fail-on drift without --canonical is clean (no drift computed)", async () => {
		const { code } = await auditCli(["--fail-on", "drift"]);
		expect(code).toBe(0);
	});

	test("--fail-on drift with --canonical trips on missing canonical files (exit 2)", async () => {
		const { code, stderr } = await auditCli(["--canonical", "1.0.0", "--fail-on", "drift"]);
		expect(code).toBe(2);
		expect(stderr).toContain("canonical drift detected");
	});

	test("--fail-on level clears a low threshold but trips a high one", async () => {
		const low = await auditCli(["--fail-on", "level", "--min-level", "1"]);
		expect(low.code).toBe(0);
		const high = await auditCli(["--fail-on", "level", "--min-level", "5"]);
		expect(high.code).toBe(2);
		expect(high.stderr).toContain("below minimum L5");
	});

	test("an out-of-range --min-level is an operational error (exit 1)", async () => {
		const { code, stderr } = await auditCli(["--fail-on", "level", "--min-level", "9"]);
		expect(code).toBe(1);
		expect(stderr).toContain("--min-level");
	});

	test("an invalid --fail-on value is rejected by commander (exit non-zero)", async () => {
		const { code } = await auditCli(["--fail-on", "bogus"]);
		expect(code).not.toBe(0);
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
