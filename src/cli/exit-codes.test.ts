import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The CLI exit-code contract (SPEC §9, §12): `0` clean, `2` when the
 * declarative failure policy (trellis.yaml §6.5) trips — the report is still
 * emitted to stdout and the reasons go to stderr — and `1` on an operational
 * error (the audit could not run). Policy failure and operational failure are
 * always distinguishable.
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

/** An over-threshold function (CC 12 > 10): a `complexity.hotspot` finding. */
const TANGLED = `export function tangled(n: number): number {
	let out = 0;
	if (n > 0) out += 1;
	if (n > 1) out += 2;
	if (n > 2) out += 3;
	if (n > 3) out += 4;
	if (n > 4) out += 5;
	if (n > 5) out += 6;
	if (n > 6) out += 7;
	if (n > 7) out += 8;
	if (n > 8) out += 9;
	if (n > 9) out += 10;
	if (n > 10) out += 11;
	return out;
}
`;

describe("trellis audit exit-code contract (SPEC §9)", () => {
	let dir: string;

	beforeEach(() => {
		// A non-Git fixture with one over-threshold hotspot → a non-zero index.
		dir = mkdtempSync(join(tmpdir(), "trellis-cli-exit-"));
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src", "tangled.ts"), TANGLED);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("no configured policy exits 0", async () => {
		const { code, stdout } = await runCli(["audit", dir, "--json"]);
		expect(code).toBe(0);
		expect(JSON.parse(stdout).score.index).toBeGreaterThan(0);
	});

	test("a tripped maxIndex policy exits 2, still emitting the report", async () => {
		writeFileSync(join(dir, "trellis.yaml"), "policy:\n  maxIndex: 0\n");
		const { code, stdout, stderr } = await runCli(["audit", dir, "--json"]);
		expect(code).toBe(2);
		// The full report is still on stdout — the policy trips *after* emitting.
		expect(JSON.parse(stdout).score.index).toBeGreaterThan(0);
		expect(stderr).toContain("exceeds the configured maximum");
	});

	test("a satisfied maxIndex policy exits 0", async () => {
		writeFileSync(join(dir, "trellis.yaml"), "policy:\n  maxIndex: 100\n");
		const { code } = await runCli(["audit", dir]);
		expect(code).toBe(0);
	});

	test("a baseline regression trips the regression policy (exit 2)", async () => {
		writeFileSync(join(dir, "trellis.yaml"), "policy:\n  regression:\n    maxIncrease: 0\n");
		// Baseline: the clean workspace (no hotspot yet).
		const clean = join(dir, "clean");
		mkdirSync(clean);
		writeFileSync(join(clean, "package.json"), JSON.stringify({ name: "fixture" }));
		mkdirSync(join(clean, "src"));
		writeFileSync(
			join(clean, "src", "add.ts"),
			"export function add(a: number, b: number): number {\n\treturn a + b;\n}\n",
		);
		const baselinePath = join(dir, "baseline.json");
		const saved = await runCli(["audit", clean, "--out", baselinePath]);
		expect(saved.code).toBe(0);

		const { code, stdout, stderr } = await runCli(["audit", dir, "--baseline", baselinePath]);
		expect(code).toBe(2);
		expect(stdout).toContain("baseline comparison");
		expect(stdout).toContain("policy: FAILED");
		expect(stderr).toContain("index rose");
	});

	test("an incompatible baseline fails closed on baseline-dependent policies (exit 2)", async () => {
		writeFileSync(join(dir, "trellis.yaml"), "policy:\n  regression:\n    maxIncrease: 5\n");
		const saved = await runCli(["audit", dir, "--out", join(dir, "baseline.json")]);
		expect(saved.code).toBe(0);
		const tampered = JSON.parse(readFileSync(join(dir, "baseline.json"), "utf8")) as {
			scoringVersion: string;
		};
		tampered.scoringVersion = "0.0.0";
		writeFileSync(join(dir, "baseline.json"), JSON.stringify(tampered, null, 2));

		const { code, stderr } = await runCli(["audit", dir, "--baseline", join(dir, "baseline.json")]);
		expect(code).toBe(2);
		expect(stderr).toContain("not comparable");
	});

	test("an invalid trellis.yaml is an operational error (exit 1)", async () => {
		writeFileSync(join(dir, "trellis.yaml"), "policy:\n  maxIndex: 9000\n");
		const { code, stdout, stderr } = await runCli(["audit", dir]);
		expect(code).toBe(1);
		expect(stdout).toBe("");
		expect(stderr).toContain("invalid trellis.yaml");
	});

	test("an unreadable baseline artifact is an operational error (exit 1)", async () => {
		const { code, stdout, stderr } = await runCli([
			"audit",
			dir,
			"--baseline",
			join(dir, "missing.json"),
		]);
		expect(code).toBe(1);
		expect(stdout).toBe("");
		expect(stderr).toContain("cannot read report artifact");
	});

	test("a missing workspace root is an operational error (exit 1)", async () => {
		const { code, stdout } = await runCli(["audit", join(dir, "no-such-place")]);
		expect(code).toBe(1);
		expect(stdout).toBe("");
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
		const targets = join(dir, "targets.yaml");
		writeFileSync(
			targets,
			`targets:\n  - id: fixture\n    path: ${dir}\n    languages: [typescript]\n` +
				`  - id: gone\n    path: ${join(dir, "missing")}\n`,
		);
		const dbDir = mkdtempSync(join(tmpdir(), "trellis-cli-exit-db-"));
		try {
			const dbPath = join(dbDir, "trellis.db");
			const fail = await runCli(["fleet", "--targets", targets, "--db", dbPath], {
				TRELLIS_DB: "",
			});
			expect(fail.code).toBe(2);
			expect(fail.stderr).toContain("gone");
			const cleanRun = await runCli(
				["fleet", "--targets", targets, "--db", dbPath, "--fail-on", "none"],
				{ TRELLIS_DB: "" },
			);
			expect(cleanRun.code).toBe(0);
		} finally {
			rmSync(dbDir, { recursive: true, force: true });
		}
	});
});
