import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `trellis compare <baseline.json> <current.json>` (SPEC §9, §12) — artifact
 * comparison without an audit. Exit `0` when the pair is comparable, `2` when
 * it is not (the comparison is still emitted, reasons on stderr), `1` on an
 * operational error (unreadable/invalid artifact). The fixtures are real
 * reports saved by `trellis audit --out` — the exact artifacts the command
 * consumes.
 */

const MAIN = join(import.meta.dir, "main.ts");

async function runCli(
	args: string[],
	opts: { env?: Record<string, string>; cwd?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(["bun", "run", MAIN, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		...(opts.cwd ? { cwd: opts.cwd } : {}),
		env: { ...process.env, TRELLIS_LOG_LEVEL: "silent", ...opts.env },
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

describe("trellis compare", () => {
	let dir: string;
	let baselinePath: string;
	let currentPath: string;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "trellis-cli-compare-"));
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
		mkdirSync(join(dir, "src"));
		writeFileSync(
			join(dir, "src", "add.ts"),
			"export function add(a: number, b: number): number {\n\treturn a + b;\n}\n",
		);
		// Save the baseline artifact, grow a hotspot, then save the current one.
		baselinePath = join(dir, "baseline.json");
		const baseline = await runCli(["audit", dir, "--out", baselinePath], { cwd: dir });
		expect(baseline.code).toBe(0);
		writeFileSync(join(dir, "src", "tangled.ts"), TANGLED);
		currentPath = join(dir, "current.json");
		const current = await runCli(["audit", dir, "--out", currentPath], { cwd: dir });
		expect(current.code).toBe(0);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("a comparable pair exits 0 and prints the deltas", async () => {
		const { code, stdout } = await runCli(["compare", baselinePath, currentPath]);
		expect(code).toBe(0);
		expect(stdout).toContain("compatibility: comparable");
		expect(stdout).toContain("lower is better");
		expect(stdout).toContain("findings:");
		expect(stdout).toContain("metric deltas (");
	});

	test("--json emits the structured comparison", async () => {
		const { code, stdout } = await runCli(["compare", baselinePath, currentPath, "--json"]);
		expect(code).toBe(0);
		const comparison = JSON.parse(stdout);
		expect(comparison.compatibility.comparable).toBe(true);
		expect(comparison.score.delta).toBeGreaterThan(0);
		expect(comparison.findings.new.length).toBeGreaterThan(0);
	});

	test("--md emits a markdown summary", async () => {
		const { code, stdout } = await runCli(["compare", baselinePath, currentPath, "--md"]);
		expect(code).toBe(0);
		expect(stdout).toContain("**Compatibility:** comparable");
		expect(stdout).toContain("### Metric deltas");
	});

	test("an incompatible pair exits 2, still emitting the comparison", async () => {
		const tampered = JSON.parse(readFileSync(currentPath, "utf8")) as { scoringVersion: string };
		tampered.scoringVersion = "0.0.0";
		writeFileSync(currentPath, JSON.stringify(tampered, null, 2));
		const { code, stdout, stderr } = await runCli(["compare", baselinePath, currentPath]);
		expect(code).toBe(2);
		expect(stdout).toContain("NOT comparable");
		expect(stderr).toContain("not comparable");
		expect(stderr).toContain("scoring versions differ");
	});

	test("an unreadable artifact is an operational error (exit 1)", async () => {
		const { code, stdout, stderr } = await runCli([
			"compare",
			join(dir, "missing.json"),
			currentPath,
		]);
		expect(code).toBe(1);
		expect(stdout).toBe("");
		expect(stderr).toContain("cannot read report artifact");
	});

	test("an invalid artifact is an operational error (exit 1)", async () => {
		writeFileSync(join(dir, "junk.json"), JSON.stringify({ nope: true }));
		const { code, stdout, stderr } = await runCli([
			"compare",
			baselinePath,
			join(dir, "junk.json"),
		]);
		expect(code).toBe(1);
		expect(stdout).toBe("");
		expect(stderr).toContain("invalid audit report");
	});
});
