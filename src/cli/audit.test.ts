import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `trellis audit` flags, output, and history (SPEC §8, §12, trellis-9a88).
 * The default audit is stateless — no hidden database, no report files;
 * `--out` and `--history` are the explicit opt-ins. Progress goes to **stderr**
 * so the stdout contract stays machine-clean; stdout always honours
 * --json/--md (default human) for stable piping. Retired readiness-era flags
 * fail with actionable "removed in the deterministic pivot" errors. Every
 * fixture is a real non-Git temporary directory — no credentials, no
 * installed project tools.
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

describe("trellis audit output + history", () => {
	let dir: string;
	let dbDir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "trellis-audit-out-"));
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
		mkdirSync(join(dir, "src"));
		writeFileSync(
			join(dir, "src", "add.ts"),
			"export function add(a: number, b: number): number {\n\treturn a + b;\n}\n",
		);
		dbDir = mkdtempSync(join(tmpdir(), "trellis-audit-db-"));
		dbPath = join(dbDir, "trellis.db");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		rmSync(dbDir, { recursive: true, force: true });
	});

	test("the default audit is stateless: no report file, no database", async () => {
		const { code, stdout } = await runCli(["audit", dir], {
			cwd: dir,
			env: { TRELLIS_DB: dbPath },
		});
		expect(code).toBe(0);
		expect(stdout).toContain("lower is better");
		expect(existsSync(join(dir, ".trellis"))).toBe(false);
		expect(existsSync(dbPath)).toBe(false);
	});

	test("--out writes a JSON report while stdout shows the terminal summary", async () => {
		const out = join(dir, "report.json");
		const { code, stdout } = await runCli(["audit", dir, "--out", out], { cwd: dir });
		expect(code).toBe(0);
		expect(existsSync(out)).toBe(true);
		const parsed = JSON.parse(readFileSync(out, "utf8"));
		expect(parsed.schemaVersion).toBeDefined();
		expect(parsed.score.index).toBeTypeOf("number");
		// No format flag → stdout keeps the readable terminal summary, not JSON.
		expect(stdout).not.toContain('"schemaVersion"');
		expect(stdout).toContain("lower is better");
	});

	test("--md overrides a .json extension for the written file", async () => {
		const out = join(dir, "report.json");
		const { code } = await runCli(["audit", dir, "--md", "--out", out], { cwd: dir });
		expect(code).toBe(0);
		expect(readFileSync(out, "utf8").startsWith("# trellis audit")).toBe(true);
	});

	test("--out to an existing directory drops a timestamped report inside it", async () => {
		const { code, stderr } = await runCli(["audit", dir, "--out", dir], { cwd: dir });
		expect(code).toBe(0);
		const written = readdirSync(dir).filter((f) => /^audit-.*\.md$/.test(f));
		expect(written).toHaveLength(1);
		expect(stderr).toContain("report written to");
	});

	test("a bad --out target fails fast before the audit runs", async () => {
		const missing = join(dir, "no-such-dir", "report.json");
		const { code, stdout, stderr } = await runCli(["audit", dir, "--out", missing], { cwd: dir });
		expect(code).toBe(1);
		expect(stderr).toContain("could not write report to");
		// The measurement pass never ran, so no report was emitted.
		expect(stdout).toBe("");
	});

	test("--verbose progress goes to stderr, leaving stdout JSON parseable", async () => {
		const { code, stdout, stderr } = await runCli(["audit", dir, "--json", "--verbose"], {
			cwd: dir,
		});
		expect(code).toBe(0);
		expect(() => JSON.parse(stdout)).not.toThrow();
		expect(stderr).toContain("trellis:");
		expect(stderr).toContain("measuring");
	});

	test("--quiet emits no progress on stderr", async () => {
		const { code, stderr } = await runCli(["audit", dir, "--quiet"], { cwd: dir });
		expect(code).toBe(0);
		expect(stderr).toBe("");
	});

	test("--history persists the run to the SQLite history (opt-in)", async () => {
		const first = await runCli(["audit", dir, "--history", "--db", dbPath], { cwd: dir });
		const second = await runCli(["audit", dir, "--history", "--db", dbPath], { cwd: dir });
		expect(first.code).toBe(0);
		expect(second.code).toBe(0);

		const { openStore } = await import("../store/index.ts");
		const store = openStore(dbPath);
		try {
			expect(store.auditRepos()).toHaveLength(1);
			const runs = store.auditRuns(store.auditRepos()[0] ?? "");
			expect(runs).toHaveLength(2);
			expect(runs[0]?.kind).toBe("sloppiness");
		} finally {
			store.close();
		}
	});

	test("--db without --history is an operational error pointing at --history", async () => {
		const { code, stdout, stderr } = await runCli(["audit", dir, "--db", dbPath], { cwd: dir });
		expect(code).toBe(1);
		expect(stdout).toBe("");
		expect(stderr).toContain("--db only applies with --history");
		expect(existsSync(dbPath)).toBe(false);
	});
});

describe("trellis audit retired flags (SPEC §12, §14)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "trellis-audit-legacy-"));
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture" }));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	/** Every retired flag fails with exit 1, no stdout, and an actionable message. */
	const RETIRED: { args: string[]; name: string; guidance: string }[] = [
		{ args: ["--no-cache"], name: "--no-cache", guidance: "Remove --no-cache" },
		{ args: ["--rubric-version", "1.0.0"], name: "--rubric-version", guidance: "no rubric" },
		{ args: ["--rubric-dir", "x"], name: "--rubric-dir", guidance: "no rubric" },
		{ args: ["--canonical", "1.0.0"], name: "--canonical", guidance: "trellis drift" },
		{ args: ["--no-persist"], name: "--no-persist", guidance: "stateless by default" },
		{ args: ["--fail-on", "gate"], name: "--fail-on", guidance: "trellis.yaml" },
		{ args: ["--min-level", "3"], name: "--min-level", guidance: "trellis.yaml" },
		{ args: ["--output", "r.md"], name: "--output", guidance: "--out" },
		{ args: ["--no-output"], name: "--no-output", guidance: "--out" },
	];

	for (const { args, name, guidance } of RETIRED) {
		test(`${name} is rejected with an actionable retirement message`, async () => {
			const { code, stdout, stderr } = await runCli(["audit", dir, ...args], { cwd: dir });
			expect(code).toBe(1);
			expect(stdout).toBe("");
			expect(stderr).toContain(name);
			expect(stderr).toContain(guidance);
		});
	}

	test("TRELLIS_PI_BIN is rejected with an actionable retirement message", async () => {
		const { code, stdout, stderr } = await runCli(["audit", dir], {
			cwd: dir,
			env: { TRELLIS_PI_BIN: "/usr/local/bin/pi" },
		});
		expect(code).toBe(1);
		expect(stdout).toBe("");
		expect(stderr).toContain("TRELLIS_PI_BIN no longer exists");
		expect(stderr).toContain("Remove TRELLIS_PI_BIN");
	});
});
