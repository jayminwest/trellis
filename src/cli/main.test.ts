import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
		// Keep stdout machine-clean even if a future default logs at info.
		env: { ...process.env, TRELLIS_LOG_LEVEL: "silent", ...env },
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	return { code, stdout, stderr };
}

describe("retired readiness catalog", () => {
	// Tests spawn the CLI as a subprocess (audit runs, reads); the 20s budget
	// accommodates slow CI containers where the 5s default is marginal.
	test("rejects rubric and its old options with migration guidance", async () => {
		const { code, stdout, stderr } = await runCli(["rubric", "--validate", "--rubric-dir", "gone"]);
		expect(code).toBe(1);
		expect(stdout).toBe("");
		expect(stderr).toContain("removed in the deterministic pivot");
		expect(stderr).toContain("trellis.yaml");
	}, 20_000);
});

describe("trellis (program)", () => {
	test("--version prints the package version", async () => {
		const { code, stdout } = await runCli(["--version"]);
		expect(code).toBe(0);
		expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
	}, 20_000);

	test("an unknown command exits non-zero", async () => {
		const { code } = await runCli(["does-not-exist"]);
		expect(code).not.toBe(0);
	}, 20_000);
});

describe("trellis standards", () => {
	test("prints the canonical set version and a per-file table", async () => {
		const { code, stdout } = await runCli(["standards"]);
		expect(code).toBe(0);
		expect(stdout).toContain("canonical set");
		expect(stdout).toContain("biome.json");
		expect(stdout).toContain("matcher");
	}, 20_000);

	test("--json emits the manifest document", async () => {
		const { code, stdout } = await runCli(["standards", "--json"]);
		expect(code).toBe(0);
		const manifest = JSON.parse(stdout);
		expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(Array.isArray(manifest.files)).toBe(true);
		expect(manifest.files[0]).toHaveProperty("matcher");
	}, 20_000);

	test("--md emits a markdown table", async () => {
		const { code, stdout } = await runCli(["standards", "--md"]);
		expect(code).toBe(0);
		expect(stdout).toContain("# Canonical standards");
		expect(stdout).toContain("| File | Version | Matcher |");
	}, 20_000);
});

describe("trellis drift", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "trellis-cli-drift-"));
		// A repo with no canonical files at all → every file reports missing.
		writeFileSync(join(dir, "README.md"), "# fixture\n");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("prints a per-file drift table for a repo lacking canonical files", async () => {
		const { code, stdout } = await runCli(["drift", dir, "--fail-on", "none"]);
		expect(code).toBe(0);
		expect(stdout).toContain("trellis drift");
		expect(stdout).toContain("biome.json");
		expect(stdout).toContain("MISS");
	}, 20_000);

	test("--json emits a parseable drift report with a summary", async () => {
		const { code, stdout } = await runCli(["drift", dir, "--json", "--fail-on", "none"]);
		expect(code).toBe(0);
		const report = JSON.parse(stdout);
		expect(report.canonicalVersion).toMatch(/^\d+\.\d+\.\d+$/);
		expect(Array.isArray(report.files)).toBe(true);
		expect(report.summary.missing).toBe(report.files.length);
	}, 20_000);

	test("--md emits a markdown table", async () => {
		const { code, stdout } = await runCli(["drift", dir, "--md", "--fail-on", "none"]);
		expect(code).toBe(0);
		expect(stdout).toContain("# Canonical drift");
		expect(stdout).toContain("| File | State | Matcher | Note |");
	}, 20_000);

	test("an unbundled --canonical version errors out", async () => {
		const { code, stderr } = await runCli(["drift", dir, "--canonical", "9.9.9"]);
		expect(code).not.toBe(0);
		expect(stderr).toContain("not bundled");
	}, 20_000);
});

describe("trellis audit (program smoke)", () => {
	let dir: string;

	beforeEach(async () => {
		// A minimal non-Git workspace; the full audit surface lives in audit.test.ts.
		dir = mkdtempSync(join(tmpdir(), "trellis-cli-audit-"));
		const { seedFixtureRepo } = await import("../report/audit-fixtures.ts");
		await seedFixtureRepo(dir, "clean");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("prints the sloppiness report for a clean workspace (exit 0)", async () => {
		const { code, stdout } = await runCli(["audit", dir, "--quiet"], {
			TRELLIS_DB: join(dir, "trellis.db"),
		});
		expect(code).toBe(0);
		expect(stdout).toContain("sloppiness index 0/100");
		expect(stdout).toContain("lower is better");
	}, 20_000);

	test("--help lists the deterministic surface (audit + compare)", async () => {
		const { code, stdout } = await runCli(["--help"]);
		expect(code).toBe(0);
		expect(stdout).toContain("sloppiness audit");
		expect(stdout).toContain("audit");
		expect(stdout).toContain("compare");
		expect(stdout).not.toContain("rubric");
	}, 20_000);
});
