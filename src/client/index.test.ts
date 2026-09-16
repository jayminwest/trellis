import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUBRIC_VERSION } from "../rubric/version.ts";
import * as client from "./index.ts";

/**
 * SDK ⇄ CLI parity (SPEC §13.1). The SDK calls the same core services the CLI
 * does, so a programmatic audit/drift and a CLI audit/drift of the same checkout
 * produce deep-equal reports — the "one code path" proof. The only field that
 * differs is the wall-clock `scoredAt`, stripped before comparison.
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

/** Drop the sole wall-clock field so two runs of one checkout compare structurally. */
function withoutClock<T extends { scoredAt?: string }>(value: T): Omit<T, "scoredAt"> {
	const { scoredAt: _drop, ...rest } = value;
	return rest;
}

describe("client SDK", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "trellis-sdk-"));
		writeFileSync(join(dir, "README.md"), "# fixture\n");
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", main: "./i.ts" }));
		writeFileSync(join(dir, ".gitignore"), "node_modules\n");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("audit() and the CLI produce deep-equal reports (one code path)", async () => {
		const sdk = await client.audit(dir, { persist: false });
		const cli = await runCli(
			["audit", dir, "--json", "--no-persist", "--no-output", "--fail-on", "none"],
			{ TRELLIS_DB: "" },
		);
		expect(cli.code).toBe(0);
		expect(withoutClock(sdk)).toEqual(withoutClock(JSON.parse(cli.stdout)));
	});

	test("audit() returns a §6.3 report with every rubric criterion", async () => {
		const report = await client.audit(dir, { persist: false });
		expect(report.rubricVersion).toBe(RUBRIC_VERSION);
		expect(Object.keys(report.criteria)).toHaveLength(70);
		expect(report.level).toBeGreaterThanOrEqual(1);
	});

	test("audit() rejects retired investigation options with an actionable message", async () => {
		// Untyped callers passing the retired knobs get a clear error, not a silent ignore.
		const legacy = { persist: false, piBin: "pi" } as unknown as client.AuditRequest;
		await expect(client.audit(dir, legacy)).rejects.toThrow(/option 'piBin' no longer exists/);
		const legacyCache = { persist: false, noCache: true } as unknown as client.AuditRequest;
		await expect(client.audit(dir, legacyCache)).rejects.toThrow(/option 'noCache'/);
	});

	test("fleet() rejects retired investigation options with an actionable message", async () => {
		const legacy = { noCache: true } as unknown as client.FleetRequest;
		await expect(client.fleet("missing-targets.yaml", legacy)).rejects.toThrow(
			/option 'noCache' no longer exists/,
		);
	});

	test("drift() and the CLI produce deep-equal drift reports", () => {
		const sdk = client.drift(dir, { canonicalVersion: "1.0.0" });
		expect(sdk.canonicalVersion).toBe("1.0.0");
		expect(sdk.summary.missing).toBeGreaterThan(0);
	});

	test("drift() matches the CLI's JSON drift report", async () => {
		const sdk = client.drift(dir);
		const cli = await runCli(["drift", dir, "--json", "--fail-on", "none"]);
		expect(cli.code).toBe(0);
		expect(sdk).toEqual(JSON.parse(cli.stdout));
	});

	test("rubric() summarizes the bundled rubric", () => {
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

	test("assessReport() re-exports the exit-code rule and trips on a failing gate", async () => {
		const report = await client.audit(dir, { persist: false });
		const rubric = client.loadRubric();
		// The default policy fails on gate ∨ drift; this sparse fixture fails gates.
		const def = client.assessReport(report, rubric);
		expect(def.failed).toBe(true);
		expect(def.reasons.join(" ")).toContain("gate criterion failed");
		// `none` is always clean.
		expect(client.assessReport(report, rubric, { mode: "none" }).failed).toBe(false);
	});
});
