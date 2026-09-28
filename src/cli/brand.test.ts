import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as client from "../client/index.ts";

const MAIN = join(import.meta.dir, "main.ts");

/** Spawn the CLI with `args` and capture exit code + streams. */
async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(["bun", "run", MAIN, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, TRELLIS_LOG_LEVEL: "silent" },
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { code: await proc.exited, stdout, stderr };
}

describe("trellis brand", () => {
	let dir: string;

	beforeEach(() => {
		// Only a README without badges → every rule reports a finding.
		dir = mkdtempSync(join(tmpdir(), "trellis-cli-brand-"));
		writeFileSync(join(dir, "README.md"), "# fixture\n");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("prints findings and exits 0 by default", async () => {
		const { code, stdout } = await runCli(["brand", dir]);
		expect(code).toBe(0);
		expect(stdout).toContain("trellis brand");
		expect(stdout).toContain("4 findings / 4 rules");
		expect(stdout).toContain("readme-badges: README.md lacks badges: npm, CI, license");
	}, 20_000);

	test("--json matches the SDK brand report", async () => {
		const { code, stdout } = await runCli(["brand", dir, "--json"]);
		expect(code).toBe(0);
		expect(JSON.parse(stdout)).toEqual(client.brand(dir));
	}, 20_000);

	test("--md emits a markdown table", async () => {
		const { code, stdout } = await runCli(["brand", dir, "--md"]);
		expect(code).toBe(0);
		expect(stdout).toContain("# Brand check");
		expect(stdout).toContain("| Rule | Finding |");
	}, 20_000);

	test("--fail-on findings exits 2 when findings exist", async () => {
		const { code, stderr } = await runCli(["brand", dir, "--fail-on", "findings"]);
		expect(code).toBe(2);
		expect(stderr).toContain("brand findings detected (4)");
	}, 20_000);
});
