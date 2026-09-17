import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LegacyConfigError } from "../legacy.ts";
import { openStore } from "../store/index.ts";
import { runAudit } from "./run.ts";

/**
 * The legacy readiness audit service (transitional, SPEC §14 — it leaves with
 * the rubric in the staged plan; the deterministic surface is
 * `src/audit/run.ts`). These tests keep the store-lifecycle contract honest
 * while the transitional `fleet` path still shares this legacy core:
 * persist-by-default with the prior run read before the new one is inserted,
 * `persist: false` touching no database, and actionable rejection of retired
 * investigation knobs.
 */

describe("runAudit (legacy, transitional)", () => {
	let dir: string;
	let dbDir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "trellis-legacy-run-"));
		writeFileSync(join(dir, "README.md"), "# fixture\n");
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", main: "./i.ts" }));
		writeFileSync(join(dir, ".gitignore"), "node_modules\n");
		dbDir = mkdtempSync(join(tmpdir(), "trellis-legacy-run-db-"));
		dbPath = join(dbDir, "trellis.db");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		rmSync(dbDir, { recursive: true, force: true });
	});

	test("persist: false audits without touching a database", async () => {
		const report = await runAudit(dir, { persist: false });
		expect(Object.keys(report.criteria)).toHaveLength(70);
		expect(existsSync(dbPath)).toBe(false);
	});

	test("persists each run and reads the prior run before inserting the new one", async () => {
		const first = await runAudit(dir, { db: dbPath });
		const second = await runAudit(dir, { db: dbPath });
		expect(existsSync(dbPath)).toBe(true);
		// The second run's §11 delta reflects the first (read-before-write).
		expect(second.changesSinceLastRun).toBeDefined();
		expect(first.changesSinceLastRun).toBeUndefined();
		const store = openStore(dbPath);
		try {
			expect(store.runsSince(second.repo, "2000-01-01T00:00:00.000Z")).toHaveLength(2);
		} finally {
			store.close();
		}
	});

	test("rejects retired investigation options with an actionable message", async () => {
		const legacy = { persist: false, piBin: "pi" };
		await expect(runAudit(dir, legacy)).rejects.toThrow(LegacyConfigError);
		await expect(runAudit(dir, legacy)).rejects.toThrow(/option 'piBin' no longer exists/);
	});
});
