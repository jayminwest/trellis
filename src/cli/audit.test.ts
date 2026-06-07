import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `trellis audit` observability + file export (SPEC §12, trellis-9b72). Progress
 * goes to **stderr** so the stdout contract stays machine-clean; `--output`
 * writes the report to a file (format inferred from the extension) while stdout
 * keeps the readable terminal summary.
 */

const MAIN = join(import.meta.dir, "main.ts");
const NO_PI = "trellis-pi-absent";

async function runCli(
	args: string[],
	env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(["bun", "run", MAIN, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, TRELLIS_LOG_LEVEL: "silent", TRELLIS_PI_BIN: NO_PI, ...env },
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
		const { code, stdout } = await runCli([
			"audit",
			dir,
			"--no-persist",
			"--fail-on",
			"none",
			"--output",
			out,
		]);
		expect(code).toBe(0);
		expect(existsSync(out)).toBe(true);
		const parsed = JSON.parse(readFileSync(out, "utf8"));
		expect(Object.keys(parsed.criteria)).toHaveLength(90);
		// stdout keeps the readable terminal summary, not the JSON payload.
		expect(stdout).not.toContain('"criteria"');
		expect(stdout.length).toBeGreaterThan(0);
	});

	test("--md overrides a .json extension for the written file", async () => {
		const out = join(dir, "report.json");
		const { code } = await runCli([
			"audit",
			dir,
			"--no-persist",
			"--fail-on",
			"none",
			"--md",
			"--output",
			out,
		]);
		expect(code).toBe(0);
		expect(readFileSync(out, "utf8").startsWith("#")).toBe(true);
	});

	test("--verbose progress goes to stderr, leaving stdout JSON parseable", async () => {
		const { code, stdout, stderr } = await runCli([
			"audit",
			dir,
			"--no-persist",
			"--fail-on",
			"none",
			"--json",
			"--verbose",
		]);
		expect(code).toBe(0);
		expect(() => JSON.parse(stdout)).not.toThrow();
		expect(stderr).toContain("trellis:");
		expect(stderr).toContain("running detectors");
	});

	test("--quiet emits no progress on stderr", async () => {
		const { code, stderr } = await runCli([
			"audit",
			dir,
			"--no-persist",
			"--fail-on",
			"none",
			"--quiet",
		]);
		expect(code).toBe(0);
		expect(stderr).toBe("");
	});
});
