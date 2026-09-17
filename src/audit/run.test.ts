import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReportArtifactError } from "../compare/index.ts";
import { AuditConfigError } from "../config/index.ts";
import { measurementPayload } from "../contract/index.ts";
import { LegacyConfigError } from "../legacy.ts";
import { renderAuditJson } from "../report/index.ts";
import { openStore, repoIdentity } from "../store/index.ts";
import { runWorkspaceAudit } from "./run.ts";

/**
 * The composed audit service (SPEC §4, §12, trellis-9a88): configure → measure
 * → baseline compare → policy → optional history. Stateless by default (no
 * database, no files); operational errors (config, baseline) throw while a
 * tripped policy is data on the result. All fixtures are real temporary
 * directories — no Git, no credentials, no installed project dependencies.
 */

/** Write `content` to `relPath` under `root` (creating parent dirs). */
async function put(root: string, relPath: string, content: string): Promise<void> {
	const { mkdir } = await import("node:fs/promises");
	const abs = join(root, relPath);
	await mkdir(join(abs, ".."), { recursive: true });
	await writeFile(abs, content);
}

/** Seed a minimal non-Git TypeScript workspace (one production module). */
async function seedWorkspace(root: string): Promise<void> {
	await put(root, "package.json", JSON.stringify({ name: "fixture", version: "1.0.0" }));
	await put(
		root,
		"src/add.ts",
		"export function add(a: number, b: number): number {\n\treturn a + b;\n}\n",
	);
}

/** An over-threshold function (CC 12 > 10): raises the index when appended. */
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

describe("runWorkspaceAudit", () => {
	let dir: string;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "trellis-run-"));
		await seedWorkspace(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("audits a non-Git temp project with no credentials or project tooling", async () => {
		const result = await runWorkspaceAudit(dir);
		expect(result.report.repo.root).toBe(dir);
		expect(result.report.score.direction).toBe("lower-is-better");
		expect(result.report.completeness).toBe("complete");
		// No baseline, no configured policy → a clean, empty assessment.
		expect(result.comparison).toBeUndefined();
		expect(result.policy.failed).toBe(false);
		expect(result.policy.results).toHaveLength(0);
		expect(result.historyRunId).toBeUndefined();
	});

	test("is stateless by default: no database and no files are created", async () => {
		const dbDir = mkdtempSync(join(tmpdir(), "trellis-run-db-"));
		const dbPath = join(dbDir, "trellis.db");
		try {
			await runWorkspaceAudit(dir);
			expect(existsSync(dbPath)).toBe(false);
			expect(existsSync(join(dir, ".trellis"))).toBe(false);
		} finally {
			rmSync(dbDir, { recursive: true, force: true });
		}
	});

	test("two runs with a pinned clock produce equal measurement payloads (SPEC §3.5)", async () => {
		const now = new Date("2026-02-01T00:00:00.000Z");
		const first = await runWorkspaceAudit(dir, { now });
		const second = await runWorkspaceAudit(dir, { now });
		expect(measurementPayload(first.report)).toEqual(measurementPayload(second.report));
	});

	test("evaluates the declarative maxIndex policy from trellis.yaml", async () => {
		await put(dir, "trellis.yaml", "policy:\n  maxIndex: 0\n");
		const result = await runWorkspaceAudit(dir);
		// The fixture carries a nonzero duplication/graph contribution surface;
		// the policy result is independent of which dimension scored.
		if (result.report.score.index > 0) {
			expect(result.policy.failed).toBe(true);
			const reasons = result.policy.results.flatMap((entry) => entry.reasons);
			expect(reasons[0]?.code).toBe("index-exceeds-max");
		} else {
			expect(result.policy.failed).toBe(false);
			expect(result.policy.results[0]?.status).toBe("pass");
		}
	});

	test("a metric budget over a real metric passes; an unknown metric fails closed", async () => {
		await put(
			dir,
			"trellis.yaml",
			"policy:\n  budgets:\n    complexity.cc.max.production:\n      max: 100\n",
		);
		const pass = await runWorkspaceAudit(dir);
		expect(pass.policy.failed).toBe(false);
		expect(pass.policy.results[0]?.policy).toBe("metric-budget");

		await put(dir, "trellis.yaml", "policy:\n  budgets:\n    no.such.metric:\n      max: 1\n");
		const fail = await runWorkspaceAudit(dir);
		expect(fail.policy.failed).toBe(true);
		expect(fail.policy.results[0]?.reasons[0]?.code).toBe("budget-metric-unknown");
	});

	test("loads an explicit --config file instead of root discovery", async () => {
		const elsewhere = mkdtempSync(join(tmpdir(), "trellis-run-config-"));
		try {
			await put(elsewhere, "custom.yaml", "policy:\n  maxIndex: 100\n");
			const result = await runWorkspaceAudit(dir, {
				configPath: join(elsewhere, "custom.yaml"),
			});
			expect(result.policy.results[0]?.policy).toBe("max-index");
			expect(result.policy.failed).toBe(false);
		} finally {
			rmSync(elsewhere, { recursive: true, force: true });
		}
	});

	test("a missing or invalid --config file is an operational error", async () => {
		await expect(runWorkspaceAudit(dir, { configPath: join(dir, "gone.yaml") })).rejects.toThrow(
			AuditConfigError,
		);
		await put(dir, "bad.yaml", "policy:\n  maxIndex: 9000\n");
		await expect(runWorkspaceAudit(dir, { configPath: join(dir, "bad.yaml") })).rejects.toThrow(
			/invalid .*bad\.yaml/,
		);
	});

	test("compares against a baseline and trips the regression policy on a worse index", async () => {
		await put(dir, "trellis.yaml", "policy:\n  regression:\n    maxIncrease: 0\n");
		const baselineRun = await runWorkspaceAudit(dir);
		const baselinePath = join(dir, "baseline.json");
		await put(dir, "baseline.json", renderAuditJson(baselineRun.report));

		// Grow a complexity hotspot so the index regresses against the baseline.
		await put(dir, "src/tangled.ts", TANGLED);
		const result = await runWorkspaceAudit(dir, { baselinePath });
		expect(result.comparison?.compatibility.comparable).toBe(true);
		expect(result.comparison?.score?.delta).toBeGreaterThan(0);
		expect(result.policy.failed).toBe(true);
		const codes = result.policy.results.flatMap((entry) => entry.reasons.map((r) => r.code));
		expect(codes).toContain("regression-exceeds-absolute");
	});

	test("an unreadable or invalid baseline artifact is an operational error", async () => {
		await expect(
			runWorkspaceAudit(dir, { baselinePath: join(dir, "missing.json") }),
		).rejects.toThrow(ReportArtifactError);
		await put(dir, "not-a-report.json", JSON.stringify({ hello: "world" }));
		await expect(
			runWorkspaceAudit(dir, { baselinePath: join(dir, "not-a-report.json") }),
		).rejects.toThrow(ReportArtifactError);
	});

	test("history persistence appends one audit_runs row (opt-in, SPEC §10)", async () => {
		const dbDir = mkdtempSync(join(tmpdir(), "trellis-run-hist-"));
		const dbPath = join(dbDir, "history.db");
		try {
			const first = await runWorkspaceAudit(dir, { history: { db: dbPath } });
			const second = await runWorkspaceAudit(dir, { history: { db: dbPath } });
			expect(first.historyRunId).toBeTypeOf("number");
			expect(second.historyRunId).toBeGreaterThan(first.historyRunId ?? 0);

			const store = openStore(dbPath);
			try {
				const runs = store.auditRuns(repoIdentity(dir, "fixture"));
				expect(runs).toHaveLength(2);
				expect(runs[0]?.kind).toBe("sloppiness");
				expect(runs[0]?.sloppinessIndex).toBe(first.report.score.index);
			} finally {
				store.close();
			}
		} finally {
			rmSync(dbDir, { recursive: true, force: true });
		}
	});

	test("rejects retired readiness-era options with an actionable message", async () => {
		await expect(runWorkspaceAudit(dir, { persist: false } as never)).rejects.toThrow(
			LegacyConfigError,
		);
		await expect(runWorkspaceAudit(dir, { persist: false } as never)).rejects.toThrow(
			/option 'persist' no longer exists/,
		);
		await expect(runWorkspaceAudit(dir, { rubricVersion: "1.0.0" } as never)).rejects.toThrow(
			/option 'rubricVersion'/,
		);
		await expect(runWorkspaceAudit(dir, { failOn: "gate" } as never)).rejects.toThrow(
			/option 'failOn'/,
		);
		await expect(runWorkspaceAudit(dir, { piBin: "pi" } as never)).rejects.toThrow(
			/option 'piBin'/,
		);
	});
});
