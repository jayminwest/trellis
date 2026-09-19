import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { migrate } from "./migrate.ts";
import { resolveDbPath } from "./store.ts";

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
	test("preserves unrelated records while adding audit history", () => {
		const db = new Database(":memory:");
		try {
			db.exec(
				"CREATE TABLE notes (value TEXT); INSERT INTO notes VALUES ('keep'); PRAGMA user_version = 1;",
			);
			migrate(db);
			expect(db.query("SELECT value FROM notes").all()).toEqual([{ value: "keep" }]);
			expect(db.query("SELECT COUNT(*) AS count FROM audit_runs").get()).toEqual({ count: 0 });
		} finally {
			db.close();
		}
	});

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
		expect(names).toEqual(["audit_runs"]);
		db.close();
	});
});
