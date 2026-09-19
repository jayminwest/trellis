/** Central SQLite audit history; opened only on explicit request. */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type AuditStore, auditStore } from "./audit-store.ts";
import { migrate } from "./migrate.ts";

const IN_MEMORY = ":memory:";

/** Typed audit history operations and database lifecycle. */
export interface Store extends AuditStore {
	close(): void;
}

/**
 * Resolve the DB path: an explicit argument wins, then `TRELLIS_DB`, else the
 * default `~/.trellis/trellis.db`. The in-memory sentinel passes through
 * untouched. Central by construction — the default never lands in an audited repo.
 */
export function resolveDbPath(explicit?: string): string {
	const pick = explicit ?? process.env.TRELLIS_DB?.trim();
	if (pick && pick.length > 0) return pick;
	return join(homedir(), ".trellis", "trellis.db");
}

/**
 * Open the central store at `dbPath` (resolved via {@link resolveDbPath}),
 * creating parent directories and running pending migrations. Returns a typed
 * {@link Store}; callers must {@link Store.close} when done.
 */
export function openStore(dbPath?: string): Store {
	const path = resolveDbPath(dbPath);
	if (path !== IN_MEMORY) mkdirSync(dirname(path), { recursive: true });

	const db = new Database(path, { create: true });
	db.exec("PRAGMA foreign_keys = ON;");
	migrate(db);

	return {
		...auditStore(db),
		close() {
			db.close();
		},
	};
}
