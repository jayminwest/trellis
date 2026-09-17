import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderJson } from "../report/json.ts";
import type { Report } from "../report/types.ts";
import { migrate } from "./migrate.ts";
import { openStore, resolveDbPath, type Store, storedReport } from "./store.ts";

/** A minimal but §6.3-valid report fixture; `now`-style fields are pinned for determinism. */
function makeReport(overrides: Partial<Report> = {}): Report {
	return {
		repo: "fixture",
		rubricVersion: "1.0.0",
		scoredAt: "2026-06-06T00:00:00.000Z",
		commit: "abc123",
		level: 3,
		passRate: 0.75,
		coverage: 0.9,
		apps: { ".": { description: "fixture" } },
		criteria: {
			agents_md: { numerator: 1, denominator: 1, rationale: "present" },
			ci_present: { numerator: 0, denominator: 1, rationale: "no CI" },
			swift_only: {
				numerator: null,
				denominator: 1,
				rationale: "not a Swift repo",
				naKind: "not-applicable",
			},
		},
		...overrides,
	};
}

describe("resolveDbPath", () => {
	const saved = process.env.TRELLIS_DB;
	afterEach(() => {
		if (saved === undefined) delete process.env.TRELLIS_DB;
		else process.env.TRELLIS_DB = saved;
	});

	test("an explicit argument wins over env and default", () => {
		process.env.TRELLIS_DB = "/from/env.db";
		expect(resolveDbPath("/explicit.db")).toBe("/explicit.db");
	});

	test("falls back to TRELLIS_DB when no argument is given", () => {
		process.env.TRELLIS_DB = "/from/env.db";
		expect(resolveDbPath()).toBe("/from/env.db");
	});

	test("defaults to a central ~/.trellis path, never inside a repo", () => {
		delete process.env.TRELLIS_DB;
		const path = resolveDbPath();
		expect(path).toContain(join(".trellis", "trellis.db"));
	});
});

describe("migrate", () => {
	test("is idempotent: a second migrate on the same DB is a no-op", () => {
		const db = new Database(":memory:");
		migrate(db);
		const after = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
		expect(after?.user_version).toBeGreaterThan(0);

		// Re-running must not throw (tables already exist) and must leave the version intact.
		expect(() => migrate(db)).not.toThrow();
		const again = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
		expect(again?.user_version).toBe(after?.user_version ?? -1);
		db.close();
	});

	test("creates exactly the SPEC §6.4 tables, including the append-only history", () => {
		const db = new Database(":memory:");
		migrate(db);
		const names = db
			.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all()
			.map((r) => r.name);
		expect(names).toContain("runs");
		expect(names).toContain("criterion_results");
		// Historical migrations stay append-only (SPEC §14 stage 3): the retired
		// cache table still lands on fresh DBs; the store simply has no API for it.
		expect(names).toContain("investigation_cache");
		db.close();
	});
});

describe("openStore", () => {
	let dir: string;
	let store: Store;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "trellis-store-"));
		store = openStore(join(dir, "nested", "trellis.db"));
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("insertRun writes a runs row and its exploded criterion_results in one transaction", () => {
		const runId = store.insertRun(makeReport());
		expect(runId).toBeGreaterThan(0);

		const latest = store.latestRun("fixture");
		expect(latest).not.toBeNull();
		expect(latest?.id).toBe(runId);
		expect(latest?.commit).toBe("abc123");
		expect(latest?.level).toBe(3);
		expect(latest?.reportJson).toBe(renderJson(makeReport()));
	});

	test("two audits of the same fixture produce two runs rows with identical report_json", () => {
		const report = makeReport();
		const first = store.insertRun(report);
		const second = store.insertRun(report);
		expect(second).not.toBe(first);

		const since = store.runsSince("fixture", "2026-01-01T00:00:00.000Z");
		expect(since).toHaveLength(2);
		expect(since[0]?.reportJson).toBe(since[1]?.reportJson);
	});

	test("latestRun returns the most recently scored run", () => {
		store.insertRun(makeReport({ scoredAt: "2026-06-01T00:00:00.000Z", commit: "old" }));
		store.insertRun(makeReport({ scoredAt: "2026-06-05T00:00:00.000Z", commit: "new" }));
		expect(store.latestRun("fixture")?.commit).toBe("new");
	});

	test("latestRun is null for an unknown repo", () => {
		expect(store.latestRun("never-audited")).toBeNull();
	});

	test("runsSince filters by date and orders oldest-first", () => {
		store.insertRun(makeReport({ scoredAt: "2026-01-01T00:00:00.000Z", commit: "a" }));
		store.insertRun(makeReport({ scoredAt: "2026-03-01T00:00:00.000Z", commit: "b" }));
		store.insertRun(makeReport({ scoredAt: "2026-05-01T00:00:00.000Z", commit: "c" }));

		const since = store.runsSince("fixture", "2026-02-01T00:00:00.000Z");
		expect(since.map((r) => r.commit)).toEqual(["b", "c"]);
	});

	test("criterion_results round-trips numerator nullability and na_kind", () => {
		const runId = store.insertRun(makeReport());
		const db = new Database(join(dir, "nested", "trellis.db"));
		const rows = db
			.query<{ criterion: string; numerator: number | null; na_kind: string | null }, [number]>(
				"SELECT criterion, numerator, na_kind FROM criterion_results WHERE run_id = ? ORDER BY criterion",
			)
			.all(runId);
		db.close();

		expect(rows).toHaveLength(3);
		const swift = rows.find((r) => r.criterion === "swift_only");
		expect(swift?.numerator).toBeNull();
		expect(swift?.na_kind).toBe("not-applicable");
		const ci = rows.find((r) => r.criterion === "ci_present");
		expect(ci?.numerator).toBe(0);
		expect(ci?.na_kind).toBeNull();
	});

	test("repos lists distinct repos with runs, sorted ascending", () => {
		expect(store.repos()).toEqual([]);
		store.insertRun(makeReport({ repo: "warren" }));
		store.insertRun(makeReport({ repo: "burrow" }));
		store.insertRun(makeReport({ repo: "warren", scoredAt: "2026-06-07T00:00:00.000Z" }));
		expect(store.repos()).toEqual(["burrow", "warren"]);
	});

	test("runs returns the full series oldest-first, and honors an optional since floor", () => {
		store.insertRun(makeReport({ scoredAt: "2026-01-01T00:00:00.000Z", commit: "a" }));
		store.insertRun(makeReport({ scoredAt: "2026-03-01T00:00:00.000Z", commit: "b" }));
		store.insertRun(makeReport({ scoredAt: "2026-05-01T00:00:00.000Z", commit: "c" }));

		expect(store.runs("fixture").map((r) => r.commit)).toEqual(["a", "b", "c"]);
		expect(store.runs("fixture", "2026-02-01T00:00:00.000Z").map((r) => r.commit)).toEqual([
			"b",
			"c",
		]);
	});

	test("criterionTrend joins criterion rows across runs, ordered by run then criterion", () => {
		store.insertRun(makeReport({ scoredAt: "2026-01-01T00:00:00.000Z" }));
		store.insertRun(makeReport({ scoredAt: "2026-05-01T00:00:00.000Z" }));

		const trend = store.criterionTrend("fixture");
		// 3 criteria × 2 runs, oldest run's three criteria (alpha) first.
		expect(trend).toHaveLength(6);
		expect(trend.slice(0, 3).map((r) => r.criterion)).toEqual([
			"agents_md",
			"ci_present",
			"swift_only",
		]);
		expect(trend.map((r) => r.scoredAt)).toEqual([
			"2026-01-01T00:00:00.000Z",
			"2026-01-01T00:00:00.000Z",
			"2026-01-01T00:00:00.000Z",
			"2026-05-01T00:00:00.000Z",
			"2026-05-01T00:00:00.000Z",
			"2026-05-01T00:00:00.000Z",
		]);
		const swift = trend.find((r) => r.criterion === "swift_only");
		expect(swift?.numerator).toBeNull();
		expect(swift?.naKind).toBe("not-applicable");

		// `since` floors the join just like `runs`.
		expect(store.criterionTrend("fixture", "2026-03-01T00:00:00.000Z")).toHaveLength(3);
	});

	test("storedReport round-trips a persisted run back into its §6.3 report", () => {
		const report = makeReport({ level: 4 });
		store.insertRun(report);
		const latest = store.latestRun("fixture");
		expect(latest).not.toBeNull();
		if (latest) expect(storedReport(latest)).toEqual(report);
	});

	test("migrate-on-open survives reopening an existing DB", () => {
		store.insertRun(makeReport());
		store.close();

		const reopened = openStore(join(dir, "nested", "trellis.db"));
		expect(reopened.latestRun("fixture")?.commit).toBe("abc123");
		store = reopened; // hand back to afterEach for cleanup
	});
});
