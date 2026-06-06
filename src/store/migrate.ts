/**
 * Migration runner (SPEC §6.4) — applies the sequential `.sql` files under
 * `migrations/` to a `bun:sqlite` database, gating on `PRAGMA user_version` so
 * `openStore` can migrate-on-open idempotently. Each filename leads with its
 * version (`0001-initial.sql` → 1); only files newer than the DB's recorded
 * `user_version` run, all inside one transaction, after which `user_version` is
 * advanced to the highest applied version. Re-opening an up-to-date DB is a
 * no-op.
 */
import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Absolute path to the bundled migrations directory, resolved off this file. */
const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

/** A failure loading or applying a migration. */
export class MigrationError extends Error {
	override readonly name = "MigrationError";
}

/** One discovered migration: its numeric version, source filename, and SQL. */
interface Migration {
	version: number;
	name: string;
	sql: string;
}

/** Load every `migrations/*.sql`, parsing the leading integer of each filename as its version. */
function loadMigrations(): Migration[] {
	const files = readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort();
	const migrations = files.map((name) => {
		const version = Number.parseInt(name, 10);
		if (!Number.isInteger(version) || version <= 0) {
			throw new MigrationError(`migration filename must start with a positive integer: ${name}`);
		}
		return { version, name, sql: readFileSync(join(MIGRATIONS_DIR, name), "utf8") };
	});
	for (let i = 1; i < migrations.length; i++) {
		const prev = migrations[i - 1];
		const cur = migrations[i];
		if (prev && cur && cur.version <= prev.version) {
			throw new MigrationError(
				`migration versions must be strictly increasing: ${prev.name} → ${cur.name}`,
			);
		}
	}
	return migrations;
}

/** Read the DB's current schema version (`PRAGMA user_version`), `0` on a fresh DB. */
function currentVersion(db: Database): number {
	const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
	return row?.user_version ?? 0;
}

/**
 * Apply all migrations newer than the DB's `user_version`, in order, inside one
 * transaction; advance `user_version` to the highest applied. Idempotent: a no-op
 * when the DB is already current.
 */
export function migrate(db: Database): void {
	const migrations = loadMigrations();
	const from = currentVersion(db);
	const pending = migrations.filter((m) => m.version > from);
	if (pending.length === 0) return;

	const apply = db.transaction(() => {
		let applied = from;
		for (const m of pending) {
			db.exec(m.sql);
			applied = m.version;
		}
		// user_version takes a literal, not a bound parameter; `applied` is a
		// validated integer derived from filenames, so interpolation is safe.
		db.exec(`PRAGMA user_version = ${applied}`);
	});
	apply();
}
