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

describe("trellis report", () => {
	let repoDir: string;
	let workDir: string;
	let dbPath: string;
	let targetsFile: string;

	const NO_PI = { TRELLIS_PI_BIN: "trellis-pi-absent" } as const;

	beforeEach(() => {
		repoDir = mkdtempSync(join(tmpdir(), "trellis-report-repo-"));
		writeFileSync(join(repoDir, "README.md"), "# fixture\n");
		writeFileSync(
			join(repoDir, "package.json"),
			JSON.stringify({ name: "fixture", main: "./i.ts" }),
		);
		writeFileSync(join(repoDir, ".gitignore"), "node_modules\n");

		workDir = mkdtempSync(join(tmpdir(), "trellis-report-work-"));
		dbPath = join(workDir, "trellis.db");
		targetsFile = join(workDir, "targets.yaml");
		writeFileSync(
			targetsFile,
			`targets:\n  - id: fixture\n    path: ${repoDir}\n    languages: [typescript]\n`,
		);
	});

	afterEach(() => {
		rmSync(repoDir, { recursive: true, force: true });
		rmSync(workDir, { recursive: true, force: true });
	});

	/** Run the fleet once against the current fixture state. */
	async function fleetRun(): Promise<void> {
		const { code } = await runCli(["fleet", "--targets", targetsFile, "--db", dbPath], {
			TRELLIS_DB: "",
			...NO_PI,
		});
		expect(code).toBe(0);
	}

	test("reports an empty dashboard on a store with no runs", async () => {
		const { code, stdout } = await runCli(["report", "--db", dbPath, "--json"], { TRELLIS_DB: "" });
		expect(code).toBe(0);
		const report = JSON.parse(stdout);
		expect(report.fleet).toEqual([]);
		expect(report.repos).toEqual([]);
		expect(report.rubricVersion).toBe(RUBRIC_VERSION);
	});

	test("after two fleet runs of a changed fixture, shows the criterion-level diff with code attribution", async () => {
		await fleetRun();
		// Change the fixture so deterministic criteria flip fail→pass between runs.
		writeFileSync(join(repoDir, "biome.json"), JSON.stringify({ linter: { enabled: true } }));
		writeFileSync(
			join(repoDir, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { strict: true, noUncheckedIndexedAccess: true } }),
		);
		await fleetRun();

		const { code, stdout } = await runCli(
			["report", "--repo", "fixture", "--db", dbPath, "--json"],
			{
				TRELLIS_DB: "",
			},
		);
		expect(code).toBe(0);
		const report = JSON.parse(stdout);

		const detail = report.repos.find((r: { repo: string }) => r.repo === "fixture");
		expect(detail.runs).toHaveLength(2);
		const delta = detail.changesSinceLastRun;
		expect(delta).not.toBeNull();
		// Same rubric across both runs ⇒ a real code improvement, not a rubric artifact.
		expect(delta.rubricVersionChanged).toBe(false);
		expect(delta.attribution).toBe("code");
		// Adding the configs flips several criteria into passing.
		expect(delta.transitions.length).toBeGreaterThan(0);
		expect(delta.transitions.some((t: { kind: string }) => t.kind === "fail-to-pass")).toBe(true);
		// The moved criteria surface as trends.
		expect(detail.trends.length).toBeGreaterThan(0);
	});

	test("renders the human dashboard with the snapshot table after a run", async () => {
		await fleetRun();
		const { code, stdout } = await runCli(["report", "--db", dbPath], { TRELLIS_DB: "" });
		expect(code).toBe(0);
		expect(stdout).toContain("trellis report");
		expect(stdout).toContain("fleet snapshot");
		expect(stdout).toContain("fixture");
	});
});
