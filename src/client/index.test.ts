import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditFixture, seedFixtureRepo } from "../report/audit-fixtures.ts";
import { renderAuditJson } from "../report/audit-json.ts";
import * as client from "./index.ts";

/**
 * SDK ⇄ CLI parity (SPEC §12, §13.1, trellis-9a88). The SDK calls the same
 * core services the CLI folds, so a programmatic audit/compare and a CLI
 * audit/compare of the same inputs produce deep-equal results — the "one
 * code path" proof, covering measurement AND policy. The only fields that
 * differ are the wall-clock run metadata (`run.auditedAt`,
 * `run.durationMs`), stripped before comparison.
 */

const MAIN = join(import.meta.dir, "..", "cli", "main.ts");

/** Spawn the CLI and capture exit code + streams. */
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

/** Drop the wall-clock run metadata so two runs of one workspace compare structurally. */
function withoutRun<T extends { run?: unknown }>(value: T): Omit<T, "run"> {
	const { run: _drop, ...rest } = value;
	return rest;
}

describe("client SDK (deterministic surface)", () => {
	let dir: string;
	let dbDir: string;
	let dbPath: string;

	beforeEach(async () => {
		// A non-Git workspace with hotspots — no credentials or project tools needed.
		dir = mkdtempSync(join(tmpdir(), "trellis-sdk-"));
		await seedFixtureRepo(dir, "sloppy");
		dbDir = mkdtempSync(join(tmpdir(), "trellis-sdk-db-"));
		dbPath = join(dbDir, "trellis.db");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		rmSync(dbDir, { recursive: true, force: true });
	});

	test("audit() and the CLI produce deep-equal reports (one measurement code path)", async () => {
		const sdk = await client.audit(dir);
		const cli = await runCli(["audit", dir, "--json", "--quiet"], { TRELLIS_DB: dbPath });
		expect(cli.code).toBe(0);
		expect(withoutRun(sdk.report)).toEqual(withoutRun(JSON.parse(cli.stdout)));
	});

	test("audit() and the CLI apply one policy code path", async () => {
		writeFileSync(join(dir, "trellis.yaml"), "policy:\n  maxIndex: 0\n");
		const sdk = await client.audit(dir);
		expect(sdk.policy.failed).toBe(true);
		const reason = sdk.policy.results.find((r) => r.status === "fail")?.reasons[0];
		expect(reason?.code).toBe("index-exceeds-max");
		const cli = await runCli(["audit", dir, "--json", "--quiet"], { TRELLIS_DB: dbPath });
		expect(cli.code).toBe(2);
		expect(JSON.parse(cli.stdout).score.index).toBe(sdk.report.score.index);
		expect(cli.stderr).toContain(reason?.message ?? "unreachable");
	});

	test("audit() is stateless by default — no database, no files (SPEC §8, §10)", async () => {
		const previousDb = process.env.TRELLIS_DB;
		process.env.TRELLIS_DB = dbPath;
		try {
			const result = await client.audit(dir);
			expect(result.historyRunId).toBeUndefined();
			expect(result.baseline).toBeUndefined();
			expect(existsSync(dbPath)).toBe(false);
			expect(existsSync(join(dir, ".trellis"))).toBe(false);
		} finally {
			if (previousDb === undefined) delete process.env.TRELLIS_DB;
			else process.env.TRELLIS_DB = previousDb;
		}
	});

	test("audit() with history persists and resolves the stored baseline", async () => {
		const first = await client.audit(dir, { history: true, db: dbPath });
		expect(first.historyRunId).toBeDefined();
		const second = await client.audit(dir, { history: true, db: dbPath });
		expect(second.baseline).toBeDefined();
		expect(withoutRun(second.baseline ?? second.report)).toEqual(withoutRun(first.report));
	});

	test("audit() rejects retired investigation and readiness options actionably", async () => {
		const legacy = { piBin: "pi" } as unknown as client.AuditRequest;
		await expect(client.audit(dir, legacy)).rejects.toThrow(/option 'piBin' no longer exists/);
		const legacyCache = { noCache: true } as unknown as client.AuditRequest;
		await expect(client.audit(dir, legacyCache)).rejects.toThrow(/option 'noCache'/);
		const readiness = { persist: false } as unknown as client.AuditRequest;
		await expect(client.audit(dir, readiness)).rejects.toThrow(/option 'persist' no longer exists/);
	});

	test("compare() and the CLI produce deep-equal comparisons (one code path)", async () => {
		const clean = await auditFixture("clean");
		const sloppy = await auditFixture("sloppy");
		try {
			const a = join(dbDir, "a.json");
			const b = join(dbDir, "b.json");
			writeFileSync(a, renderAuditJson(clean.report));
			writeFileSync(b, renderAuditJson(sloppy.report));
			const sdk = await client.compare(a, b);
			expect(sdk.policy).toBeNull();
			const cli = await runCli(["compare", a, b, "--json"]);
			expect(cli.code).toBe(0);
			expect(sdk.comparison).toEqual(JSON.parse(cli.stdout));
		} finally {
			await clean.cleanup();
			await sloppy.cleanup();
		}
	});

	test("compare() and the CLI apply one policy code path", async () => {
		const clean = await auditFixture("clean");
		const sloppy = await auditFixture("sloppy");
		try {
			const a = join(dbDir, "a.json");
			const b = join(dbDir, "b.json");
			writeFileSync(a, renderAuditJson(clean.report));
			writeFileSync(b, renderAuditJson(sloppy.report));
			const configPath = join(dbDir, "trellis.yaml");
			writeFileSync(configPath, "policy:\n  regression: {}\n");
			const sdk = await client.compare(a, b, { configPath });
			expect(sdk.policy?.failed).toBe(true);
			const cli = await runCli(["compare", a, b, "--config", configPath]);
			expect(cli.code).toBe(2);
			expect(cli.stderr).toContain("policy score-regression failed");
		} finally {
			await clean.cleanup();
			await sloppy.cleanup();
		}
	});

	test("assessPolicy() re-exports the exit-code rule", async () => {
		const sdk = await client.audit(dir);
		const tripped = client.assessPolicy(sdk.report, {
			maxIndex: 0,
			budgets: {},
			failOnNew: [],
		});
		expect(tripped.failed).toBe(true);
		const clean = client.assessPolicy(sdk.report, { budgets: {}, failOnNew: [] });
		expect(clean.failed).toBe(false);
	});

	test("fleet() and the CLI produce deep-equal fleet reports (one code path)", async () => {
		const cleanDir = mkdtempSync(join(tmpdir(), "trellis-sdk-clean-"));
		await seedFixtureRepo(cleanDir, "clean");
		const targetsPath = join(dbDir, "targets.yaml");
		writeFileSync(
			targetsPath,
			`targets:\n  - id: clean\n    path: ${cleanDir}\n  - id: sloppy\n    path: ${dir}\n`,
		);
		try {
			const sdk = await client.fleet(targetsPath);
			const cli = await runCli(["fleet", "--targets", targetsPath, "--json"], {
				TRELLIS_DB: dbPath,
			});
			expect(cli.code).toBe(0);
			expect(stripFleetClock(sdk)).toEqual(stripFleetClock(JSON.parse(cli.stdout)));
		} finally {
			rmSync(cleanDir, { recursive: true, force: true });
		}
	});

	test("report() projects the sloppiness history with legacy runs distinct", async () => {
		await client.audit(dir, { history: true, db: dbPath });
		const dashboard = client.report({ db: dbPath });
		expect(dashboard.audits.snapshot).toHaveLength(1);
		expect(dashboard.audits.snapshot[0]?.index).toBeGreaterThan(0);
		expect(dashboard.legacy).toEqual([]);
	});
});

/** Drop the wall-clock fields (fleet auditedAt + per-entry run metadata) for structural comparison. */
function stripFleetClock(report: client.FleetReport): unknown {
	return JSON.parse(
		JSON.stringify(report, (key, value: unknown) =>
			key === "auditedAt" || key === "durationMs" || key === "run" ? undefined : value,
		),
	);
}

describe("client SDK compatibility boundaries", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "trellis-sdk-legacy-"));
		writeFileSync(join(dir, "README.md"), "# fixture\n");
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", main: "./i.ts" }));
		writeFileSync(join(dir, ".gitignore"), "node_modules\n");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("fleet() rejects retired investigation options with an actionable message", async () => {
		const legacy = { noCache: true } as unknown as client.FleetRequest;
		await expect(client.fleet("missing-targets.yaml", legacy)).rejects.toThrow(
			/option 'noCache' no longer exists/,
		);
	});

	test("drift() matches the CLI's JSON drift report", async () => {
		const sdk = client.drift(dir);
		const cli = await runCli(["drift", dir, "--json", "--fail-on", "none"]);
		expect(cli.code).toBe(0);
		expect(sdk).toEqual(JSON.parse(cli.stdout));
	});

	test("exposes no retired readiness catalog or assessment API", () => {
		for (const name of [
			"rubric",
			"loadRubric",
			"assessReport",
			"DEFAULT_MIN_LEVEL",
			"FAIL_ON_MODES",
		]) {
			expect(Object.hasOwn(client, name)).toBe(false);
		}
	});

	test("report() on an empty store returns an empty dashboard", () => {
		const dashboard = client.report({ db: ":memory:" });
		expect(dashboard.audits.snapshot).toEqual([]);
		expect(dashboard.audits.repos).toEqual([]);
		expect(dashboard.legacy).toEqual([]);
	});
});
