import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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

/** A broken rubric: a category with no gate criterion (loader invariant 5). */
const BROKEN = {
	"categories.yaml": "- id: documentation\n  title: Documentation\n  description: Docs.\n",
	"repo-scope.yaml":
		"- id: agents_md\n  category: documentation\n  scope: repo\n  level: 1\n  skippable: false\n  discoveryVia: deterministic\n",
	"app-scope.yaml": "[]\n",
};

describe("trellis rubric", () => {
	test("prints the version and category count on the real rubric", async () => {
		const { code, stdout } = await runCli(["rubric"]);
		expect(code).toBe(0);
		expect(stdout).toContain(`@ ${RUBRIC_VERSION}`);
		expect(stdout).toContain("70 criteria across 8 categories");
	});

	test("--json emits the full summary shape on the real rubric", async () => {
		const { code, stdout } = await runCli(["rubric", "--json"]);
		expect(code).toBe(0);
		const summary = JSON.parse(stdout);
		expect(summary.rubricVersion).toBe(RUBRIC_VERSION);
		expect(summary.categoryCount).toBe(8);
		expect(summary.criterionCount).toBe(70);
		expect(summary.categories).toHaveLength(8);
		const first = summary.categories[0];
		expect(first).toHaveProperty("id");
		expect(first).toHaveProperty("criterionCount");
		expect(first).toHaveProperty("repo");
		expect(first).toHaveProperty("app");
		expect(first.levels).toEqual(expect.objectContaining({ 1: expect.any(Number) }));
		expect(first).toHaveProperty("gate");
	});

	test("--md emits a markdown table", async () => {
		const { code, stdout } = await runCli(["rubric", "--md"]);
		expect(code).toBe(0);
		expect(stdout).toContain("# trellis rubric");
		expect(stdout).toContain("| Category | Criteria |");
	});

	test("--validate is green against the real rubric (milestone 1 gate)", async () => {
		const { code, stdout } = await runCli(["rubric", "--validate", "--json"]);
		expect(code).toBe(0);
		const result = JSON.parse(stdout);
		expect(result.valid).toBe(true);
		expect(result.criterionCount).toBe(70);
	});

	test("rejects --json and --md together", async () => {
		const { code, stderr } = await runCli(["rubric", "--json", "--md"]);
		expect(code).not.toBe(0);
		expect(stderr).toContain("at most one of --json or --md");
	});
});

describe("trellis rubric --validate on a broken fixture", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "trellis-cli-"));
		for (const [name, content] of Object.entries(BROKEN)) {
			writeFileSync(join(dir, name), content);
		}
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("exits non-zero with a precise error naming id + file", async () => {
		const { code, stdout, stderr } = await runCli(["rubric", "--validate", "--rubric-dir", dir]);
		expect(code).not.toBe(0);
		expect(stdout).toBe("");
		expect(stderr).toContain("no gate:true criterion");
		expect(stderr).toContain("documentation");
		expect(stderr).toContain("categories.yaml");
	});

	test("--json error output is machine-readable with id + file", async () => {
		const { code, stdout, stderr } = await runCli([
			"rubric",
			"--validate",
			"--json",
			"--rubric-dir",
			dir,
		]);
		expect(code).not.toBe(0);
		expect(stdout).toBe("");
		const payload = JSON.parse(stderr);
		expect(payload.error.id).toBe("documentation");
		expect(payload.error.file).toBe("categories.yaml");
		expect(payload.error.message).toContain("no gate:true criterion");
	});
});

describe("trellis (program)", () => {
	test("--version prints the package version", async () => {
		const { code, stdout } = await runCli(["--version"]);
		expect(code).toBe(0);
		expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
	});

	test("an unknown command exits non-zero", async () => {
		const { code } = await runCli(["does-not-exist"]);
		expect(code).not.toBe(0);
	});
});

describe("trellis standards", () => {
	test("prints the canonical set version and a per-file table", async () => {
		const { code, stdout } = await runCli(["standards"]);
		expect(code).toBe(0);
		expect(stdout).toContain("canonical set");
		expect(stdout).toContain("biome.json");
		expect(stdout).toContain("matcher");
	});

	test("--json emits the manifest document", async () => {
		const { code, stdout } = await runCli(["standards", "--json"]);
		expect(code).toBe(0);
		const manifest = JSON.parse(stdout);
		expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(Array.isArray(manifest.files)).toBe(true);
		expect(manifest.files[0]).toHaveProperty("matcher");
	});

	test("--md emits a markdown table", async () => {
		const { code, stdout } = await runCli(["standards", "--md"]);
		expect(code).toBe(0);
		expect(stdout).toContain("# Canonical standards");
		expect(stdout).toContain("| File | Version | Matcher |");
	});
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
	});

	test("--json emits a parseable drift report with a summary", async () => {
		const { code, stdout } = await runCli(["drift", dir, "--json", "--fail-on", "none"]);
		expect(code).toBe(0);
		const report = JSON.parse(stdout);
		expect(report.canonicalVersion).toMatch(/^\d+\.\d+\.\d+$/);
		expect(Array.isArray(report.files)).toBe(true);
		expect(report.summary.missing).toBe(report.files.length);
	});

	test("--md emits a markdown table", async () => {
		const { code, stdout } = await runCli(["drift", dir, "--md", "--fail-on", "none"]);
		expect(code).toBe(0);
		expect(stdout).toContain("# Canonical drift");
		expect(stdout).toContain("| File | State | Matcher | Note |");
	});

	test("an unbundled --canonical version errors out", async () => {
		const { code, stderr } = await runCli(["drift", dir, "--canonical", "9.9.9"]);
		expect(code).not.toBe(0);
		expect(stderr).toContain("not bundled");
	});
});

describe("trellis audit", () => {
	let dir: string;
	let dbDir: string;
	let dbPath: string;

	beforeEach(() => {
		// A minimal single-app fixture — keeps detector subprocesses cheap/fast.
		dir = mkdtempSync(join(tmpdir(), "trellis-cli-audit-"));
		writeFileSync(join(dir, "README.md"), "# fixture\n");
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", main: "./i.ts" }));
		writeFileSync(join(dir, ".gitignore"), "node_modules\n");
		// A central DB outside the audited repo, so tests never touch ~/.trellis.
		dbDir = mkdtempSync(join(tmpdir(), "trellis-cli-db-"));
		dbPath = join(dbDir, "trellis.db");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		rmSync(dbDir, { recursive: true, force: true });
	});

	test("prints a coherent terminal scorecard", async () => {
		const { code, stdout } = await runCli(["audit", dir, "--no-output", "--fail-on", "none"], {
			TRELLIS_DB: dbPath,
		});
		expect(code).toBe(0);
		expect(stdout).toContain("Level ");
		expect(stdout).toContain("pass-rate");
		expect(stdout).toContain("coverage");
		expect(stdout).toContain("measured ");
	});

	test("--json emits a parseable §6.3 report with every rubric criterion", async () => {
		const { code, stdout } = await runCli(
			["audit", dir, "--json", "--no-output", "--fail-on", "none"],
			{ TRELLIS_DB: dbPath },
		);
		expect(code).toBe(0);
		const report = JSON.parse(stdout);
		expect(report.rubricVersion).toBe(RUBRIC_VERSION);
		expect(report.level).toBeGreaterThanOrEqual(1);
		expect(report.level).toBeLessThanOrEqual(5);
		expect(Object.keys(report.criteria)).toHaveLength(70);
		expect(report.apps).toBeDefined();
	});

	test("--md emits a markdown scorecard", async () => {
		const { code, stdout } = await runCli(
			["audit", dir, "--md", "--no-output", "--fail-on", "none"],
			{ TRELLIS_DB: dbPath },
		);
		expect(code).toBe(0);
		expect(stdout).toContain("# Agentic-readiness scorecard");
		expect(stdout).toContain("| Category | Measured |");
	});

	test("persists each run to the central history (SPEC §6.4)", async () => {
		const first = await runCli(["audit", dir, "--db", dbPath, "--no-output", "--fail-on", "none"], {
			TRELLIS_DB: "",
		});
		const second = await runCli(
			["audit", dir, "--db", dbPath, "--no-output", "--fail-on", "none"],
			{ TRELLIS_DB: "" },
		);
		expect(first.code).toBe(0);
		expect(second.code).toBe(0);

		const { openStore } = await import("../store/index.ts");
		const store = openStore(dbPath);
		try {
			const repo = basename(dir);
			const runs = store.runsSince(repo, "2000-01-01T00:00:00.000Z");
			expect(runs).toHaveLength(2);
		} finally {
			store.close();
		}
	});

	test("--no-persist skips writing to the history", async () => {
		const { code } = await runCli(
			["audit", dir, "--db", dbPath, "--no-persist", "--no-output", "--fail-on", "none"],
			{
				TRELLIS_DB: "",
			},
		);
		expect(code).toBe(0);
		expect(existsSync(dbPath)).toBe(false);
	});

	test("omits report.drift by default", async () => {
		const { code, stdout } = await runCli(
			["audit", dir, "--json", "--no-output", "--fail-on", "none"],
			{ TRELLIS_DB: dbPath },
		);
		expect(code).toBe(0);
		expect(JSON.parse(stdout).drift).toBeUndefined();
	});

	test("--canonical folds canonical-config drift into report.drift (SPEC §10)", async () => {
		const { code, stdout } = await runCli(
			["audit", dir, "--json", "--canonical", "1.0.0", "--no-output", "--fail-on", "none"],
			{
				TRELLIS_DB: dbPath,
			},
		);
		expect(code).toBe(0);
		const report = JSON.parse(stdout);
		expect(report.drift).toBeDefined();
		expect(report.drift.canonicalVersion).toBe("1.0.0");
		expect(report.drift.summary.missing).toBeGreaterThan(0);
	});

	test("the default report file anchors to the audited repo, not the process cwd", async () => {
		// No --output: the default report must land under the AUDITED repo's
		// `.trellis/` (here the temp `dir`), never the CLI's cwd (the real repo).
		const { code, stderr } = await runCli(["audit", dir, "--db", dbPath, "--fail-on", "none"], {
			TRELLIS_DB: "",
		});
		expect(code).toBe(0);
		const reports = readdirSync(join(dir, ".trellis")).filter((f) => /^audit-.*\.md$/.test(f));
		expect(reports).toHaveLength(1);
		expect(stderr).toContain(join(dir, ".trellis"));
	});
});
