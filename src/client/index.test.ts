import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measurementPayload } from "../contract/index.ts";
import { renderAuditJson } from "../report/index.ts";
import { RUBRIC_VERSION } from "../rubric/version.ts";
import * as client from "./index.ts";

/**
 * SDK ⇄ CLI parity (SPEC §12, §13.1, trellis-9a88). The SDK calls the same
 * core services the CLI does, so a programmatic audit/compare and a CLI
 * audit/compare of the same checkout produce deep-equal results — the "one
 * measurement and policy code path" proof. The only fields that differ are
 * the wall-clock run metadata (`run.auditedAt`, `run.durationMs`), excluded
 * from the deterministic measurement payload (SPEC §3.5).
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

describe("client SDK", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "trellis-sdk-"));
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
		mkdirSync(join(dir, "src"));
		writeFileSync(
			join(dir, "src", "add.ts"),
			"export function add(a: number, b: number): number {\n\treturn a + b;\n}\n",
		);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("audit() and the CLI produce deep-equal reports (one code path)", async () => {
		const sdk = await client.audit(dir);
		const cli = await runCli(["audit", dir, "--json"]);
		expect(cli.code).toBe(0);
		expect(measurementPayload(sdk.report)).toEqual(measurementPayload(JSON.parse(cli.stdout)));
	});

	test("audit() returns the §6.4 report plus an empty policy assessment by default", async () => {
		const result = await client.audit(dir);
		expect(result.report.score.direction).toBe("lower-is-better");
		expect(result.report.completeness).toBe("complete");
		expect(result.comparison).toBeUndefined();
		expect(result.policy.failed).toBe(false);
		expect(result.policy.results).toHaveLength(0);
		expect(result.historyRunId).toBeUndefined();
	});

	test("audit() and the CLI evaluate the same declarative policy (one policy code path)", async () => {
		writeFileSync(
			join(dir, "trellis.yaml"),
			"policy:\n  maxIndex: 0\n  budgets:\n    no.such.metric:\n      max: 1\n",
		);
		const sdk = await client.audit(dir);
		expect(sdk.policy.failed).toBe(true);
		const sdkReasons = sdk.policy.results
			.filter((entry) => entry.status === "fail")
			.flatMap((entry) => entry.reasons.map((reason) => reason.message));
		expect(sdkReasons.length).toBeGreaterThan(0);

		const cli = await runCli(["audit", dir, "--json"]);
		// The CLI exits 2 and writes the very same reasons to stderr.
		expect(cli.code).toBe(2);
		for (const reason of sdkReasons) {
			expect(cli.stderr).toContain(reason);
		}
	});

	test("audit() rejects retired readiness-era options with an actionable message", async () => {
		// Untyped callers passing the retired knobs get a clear error, not a silent ignore.
		await expect(client.audit(dir, { persist: false } as never)).rejects.toThrow(
			/option 'persist' no longer exists/,
		);
		await expect(client.audit(dir, { rubricVersion: "1.0.0" } as never)).rejects.toThrow(
			/option 'rubricVersion'/,
		);
		await expect(client.audit(dir, { piBin: "pi" } as never)).rejects.toThrow(
			/option 'piBin' no longer exists/,
		);
	});

	test("audit() with history persists to the given database", async () => {
		const dbDir = mkdtempSync(join(tmpdir(), "trellis-sdk-db-"));
		try {
			const dbPath = join(dbDir, "trellis.db");
			const result = await client.audit(dir, { history: { db: dbPath } });
			expect(result.historyRunId).toBeTypeOf("number");
		} finally {
			rmSync(dbDir, { recursive: true, force: true });
		}
	});

	test("compare() and the CLI produce deep-equal comparisons", async () => {
		const baselinePath = join(dir, "baseline.json");
		const currentPath = join(dir, "current.json");
		const first = await client.audit(dir);
		writeFileSync(baselinePath, renderAuditJson(first.report));
		writeFileSync(
			join(dir, "src", "more.ts"),
			"export function sub(a: number, b: number): number {\n\treturn a - b;\n}\n",
		);
		const second = await client.audit(dir);
		writeFileSync(currentPath, renderAuditJson(second.report));

		const sdk = await client.compare(baselinePath, currentPath);
		const cli = await runCli(["compare", baselinePath, currentPath, "--json"]);
		expect(cli.code).toBe(0);
		expect(sdk).toEqual(JSON.parse(cli.stdout));
	});

	test("fleet() rejects retired investigation options with an actionable message", async () => {
		const legacy = { noCache: true } as unknown as client.FleetRequest;
		await expect(client.fleet("missing-targets.yaml", legacy)).rejects.toThrow(
			/option 'noCache' no longer exists/,
		);
	});

	test("drift() and the CLI produce deep-equal drift reports", async () => {
		const sdk = client.drift(dir);
		const cli = await runCli(["drift", dir, "--json", "--fail-on", "none"]);
		expect(cli.code).toBe(0);
		expect(sdk).toEqual(JSON.parse(cli.stdout));
	});

	test("rubric() summarizes the bundled rubric (transitional)", () => {
		const summary = client.rubric();
		expect(summary.rubricVersion).toBe(RUBRIC_VERSION);
		expect(summary.criterionCount).toBe(70);
		expect(summary.categoryCount).toBe(8);
	});

	test("report() on an empty store returns an empty dashboard", () => {
		const dashboard = client.report({ db: ":memory:" });
		expect(dashboard.fleet).toEqual([]);
		expect(dashboard.repos).toEqual([]);
	});

	test("assessPolicy() re-exports the core policy rule", async () => {
		const result = await client.audit(dir);
		const assessment = client.assessPolicy(result.report, {
			maxIndex: 100,
			budgets: {},
			failOnNew: [],
		});
		expect(assessment.failed).toBe(false);
		expect(assessment.results[0]?.policy).toBe("max-index");
	});
});
