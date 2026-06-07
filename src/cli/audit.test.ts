import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `trellis audit` observability + file export (SPEC §12, trellis-9b72). Progress
 * goes to **stderr** so the stdout contract stays machine-clean; stdout always
 * honours --json/--md (default human) for stable piping. By default a timestamped
 * markdown report is written under `.trellis/`; `--output <path>` overrides the
 * path/format and `--no-output` skips the file entirely. Each run spawns with
 * `cwd` set to the fixture dir so any default `.trellis/` write is self-cleaning.
 */

const MAIN = join(import.meta.dir, "main.ts");
const NO_PI = "trellis-pi-absent";

async function runCli(
	args: string[],
	opts: { env?: Record<string, string>; cwd?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(["bun", "run", MAIN, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		...(opts.cwd ? { cwd: opts.cwd } : {}),
		env: { ...process.env, TRELLIS_LOG_LEVEL: "silent", TRELLIS_PI_BIN: NO_PI, ...opts.env },
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	return { code, stdout, stderr };
}

describe("trellis audit --output + progress", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "trellis-audit-out-"));
		writeFileSync(join(dir, "README.md"), "# fixture\n");
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", main: "./i.ts" }));
		writeFileSync(join(dir, ".gitignore"), "node_modules\n");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("--output writes a JSON report to the file while stdout shows the summary", async () => {
		const out = join(dir, "report.json");
		const { code, stdout } = await runCli(
			["audit", dir, "--no-persist", "--fail-on", "none", "--output", out],
			{ cwd: dir },
		);
		expect(code).toBe(0);
		expect(existsSync(out)).toBe(true);
		const parsed = JSON.parse(readFileSync(out, "utf8"));
		expect(Object.keys(parsed.criteria)).toHaveLength(90);
		// No format flag → stdout keeps the readable terminal summary, not JSON.
		expect(stdout).not.toContain('"criteria"');
		expect(stdout.length).toBeGreaterThan(0);
	});

	test("--md overrides a .json extension for the written file", async () => {
		const out = join(dir, "report.json");
		const { code } = await runCli(
			["audit", dir, "--no-persist", "--fail-on", "none", "--md", "--output", out],
			{ cwd: dir },
		);
		expect(code).toBe(0);
		expect(readFileSync(out, "utf8").startsWith("#")).toBe(true);
	});

	test("by default writes a timestamped markdown report under .trellis/", async () => {
		const { code, stderr } = await runCli(["audit", dir, "--no-persist", "--fail-on", "none"], {
			cwd: dir,
		});
		expect(code).toBe(0);
		const written = readdirSync(join(dir, ".trellis"));
		expect(written).toHaveLength(1);
		const name = written[0] ?? "";
		expect(name).toMatch(/^audit-.*\.md$/);
		expect(readFileSync(join(dir, ".trellis", name), "utf8").startsWith("#")).toBe(true);
		expect(stderr).toContain("report written to");
	});

	test("--no-output skips the default report file", async () => {
		const { code } = await runCli(
			["audit", dir, "--no-persist", "--fail-on", "none", "--no-output"],
			{ cwd: dir },
		);
		expect(code).toBe(0);
		expect(existsSync(join(dir, ".trellis"))).toBe(false);
	});

	test("--verbose progress goes to stderr, leaving stdout JSON parseable", async () => {
		const { code, stdout, stderr } = await runCli(
			["audit", dir, "--no-persist", "--fail-on", "none", "--json", "--verbose", "--no-output"],
			{ cwd: dir },
		);
		expect(code).toBe(0);
		expect(() => JSON.parse(stdout)).not.toThrow();
		expect(stderr).toContain("trellis:");
		expect(stderr).toContain("running detectors");
	});

	test("--quiet emits no progress on stderr", async () => {
		const { code, stderr } = await runCli(
			["audit", dir, "--no-persist", "--fail-on", "none", "--quiet"],
			{ cwd: dir },
		);
		expect(code).toBe(0);
		expect(stderr).toBe("");
	});

	test("--output to an existing directory drops a timestamped report inside it", async () => {
		const { code, stderr } = await runCli(
			["audit", dir, "--no-persist", "--fail-on", "none", "--output", dir],
			{ cwd: dir },
		);
		expect(code).toBe(0);
		const written = readdirSync(dir).filter((f) => /^audit-.*\.md$/.test(f));
		expect(written).toHaveLength(1);
		expect(stderr).toContain("report written to");
	});

	test("a bad --output target fails fast before the audit runs", async () => {
		const missing = join(dir, "no-such-dir", "report.json");
		const { code, stdout, stderr } = await runCli(
			["audit", dir, "--no-persist", "--fail-on", "none", "--output", missing],
			{ cwd: dir },
		);
		expect(code).toBe(1);
		expect(stderr).toContain("could not write report to");
		// The investigation/detector passes never ran, so no scorecard was emitted.
		expect(stdout).toBe("");
		expect(stderr).not.toContain("running detectors");
	});
});
