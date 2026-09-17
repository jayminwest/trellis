import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditFixture } from "../report/audit-fixtures.ts";
import { renderAuditJson } from "../report/audit-json.ts";

/**
 * `trellis compare <a.json> <b.json>` (SPEC §9, §12, trellis-9a88): artifact
 * comparison without an audit. A comparable pair prints the delta summary and
 * exits 0; a `--config` policy gates the comparison (exit 2, comparison still
 * emitted); an incompatible pair fails closed (exit 2) with explicit reasons;
 * unreadable artifacts or configuration are operational errors (exit 1).
 * Artifacts are real core-produced reports saved to a temp dir.
 */

const MAIN = join(import.meta.dir, "main.ts");

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

describe("trellis compare", () => {
	let dir: string;
	let clean: string;
	let sloppy: string;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "trellis-cli-compare-"));
		const cleanFixture = await auditFixture("clean");
		const sloppyFixture = await auditFixture("sloppy");
		try {
			clean = join(dir, "clean.json");
			sloppy = join(dir, "sloppy.json");
			writeFileSync(clean, renderAuditJson(cleanFixture.report));
			writeFileSync(sloppy, renderAuditJson(sloppyFixture.report));
		} finally {
			await cleanFixture.cleanup();
			await sloppyFixture.cleanup();
		}
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("prints the comparison summary for a comparable pair (exit 0)", async () => {
		const { code, stdout } = await runCli(["compare", clean, sloppy]);
		expect(code).toBe(0);
		expect(stdout).toContain("trellis compare ·");
		expect(stdout).toContain("comparable: yes");
		expect(stdout).toMatch(/index: 0\/100 → \d+\/100 \(\+\d+\) · lower is better/);
		expect(stdout).toContain("metric deltas:");
		expect(stdout).toMatch(/findings: \d+ new · \d+ resolved · \d+ persistent/);
	});

	test("--json emits the structured comparison", async () => {
		const { code, stdout } = await runCli(["compare", clean, sloppy, "--json"]);
		expect(code).toBe(0);
		const comparison = JSON.parse(stdout);
		expect(comparison.compatibility.comparable).toBe(true);
		expect(comparison.score.delta).toBeGreaterThan(0);
		expect(Array.isArray(comparison.metrics)).toBe(true);
		expect(Array.isArray(comparison.findings.new)).toBe(true);
	});

	test("--md emits a markdown summary", async () => {
		const { code, stdout } = await runCli(["compare", clean, sloppy, "--md"]);
		expect(code).toBe(0);
		expect(stdout).toContain("# trellis compare —");
		expect(stdout).toContain("## Index");
	});

	test("a tripped --config policy exits 2 with the comparison still emitted", async () => {
		const configPath = join(dir, "trellis.yaml");
		writeFileSync(configPath, "policy:\n  regression: {}\n  failOnNew:\n    - import-cycle\n");
		const { code, stdout, stderr } = await runCli([
			"compare",
			clean,
			sloppy,
			"--config",
			configPath,
		]);
		expect(code).toBe(2);
		expect(stdout).toContain("trellis compare ·");
		expect(stderr).toContain("policy score-regression failed");
		expect(stderr).toContain("policy new-findings failed");
	});

	test("a passing --config policy stays clean", async () => {
		const configPath = join(dir, "trellis.yaml");
		writeFileSync(configPath, "policy:\n  maxIndex: 100\n");
		const { code } = await runCli(["compare", clean, sloppy, "--config", configPath]);
		expect(code).toBe(0);
	});

	test("an incompatible pair fails closed (exit 2) with explicit reasons", async () => {
		const tampered = JSON.parse(readFileSync(sloppy, "utf8")) as { scoringVersion: string };
		tampered.scoringVersion = "0.0.0-tampered";
		writeFileSync(sloppy, JSON.stringify(tampered, null, 2));
		const { code, stdout, stderr } = await runCli(["compare", clean, sloppy]);
		expect(code).toBe(2);
		expect(stdout).toContain("comparable: NO");
		expect(stderr).toContain("not comparable");
		expect(stderr).toContain("scoring-version");
	});

	test("an unreadable artifact is an operational error (exit 1)", async () => {
		const { code, stdout, stderr } = await runCli(["compare", join(dir, "absent.json"), sloppy]);
		expect(code).toBe(1);
		expect(stdout).toBe("");
		expect(stderr).toContain("cannot read report artifact");
	});

	test("an invalid artifact is an operational error (exit 1)", async () => {
		const bad = join(dir, "bad.json");
		writeFileSync(bad, JSON.stringify({ not: "a report" }));
		const { code, stderr } = await runCli(["compare", bad, sloppy]);
		expect(code).toBe(1);
		expect(stderr).toContain("invalid audit report");
	});

	test("an invalid --config file is an operational error (exit 1)", async () => {
		const configPath = join(dir, "trellis.yaml");
		writeFileSync(configPath, "policy:\n  maxIndex: 400\n");
		const { code, stderr } = await runCli(["compare", clean, sloppy, "--config", configPath]);
		expect(code).toBe(1);
		expect(stderr).toContain("policy.maxIndex");
	});
});
