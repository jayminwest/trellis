/**
 * The central SQLite store (SPEC §6.4, §11) — trellis's run history. State is
 * **central, never per-repo** (SPEC §2): the DB lives at a trellis-owned path
 * (`~/.trellis/trellis.db` by default), overridable via the `TRELLIS_DB` env var
 * or an explicit `openStore` argument, so an audited checkout is never mutated.
 *
 * {@link openStore} opens (creating parent dirs as needed), migrates-on-open,
 * and returns a {@link Store} of typed functions: {@link Store.insertRun}
 * writes a `runs` row plus its exploded `criterion_results` in one transaction;
 * {@link Store.latestRun} / {@link Store.runsSince} drive the §11 history
 * queries; {@link Store.getCache} / {@link Store.putCache} back the
 * §7.3 investigation cache.
 *
 * `report_json` is the byte-stable §6.3 document ({@link renderJson}), so two
 * audits of the same checkout at a pinned `scoredAt` persist identical JSON.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { renderJson } from "../report/json.ts";
import type { Report } from "../report/types.ts";
import type { Level } from "../rubric/index.ts";
import type { NaKind } from "../scoring/index.ts";
import { migrate } from "./migrate.ts";

/** The in-memory DB sentinel `bun:sqlite` recognizes — never touches disk. */
const IN_MEMORY = ":memory:";

/** A row read back from `runs`, with columns mapped to camelCase. */
export interface StoredRun {
	id: number;
	repo: string;
	commit: string;
	rubricVersion: string;
	level: Level;
	passRate: number;
	coverage: number;
	reportJson: string;
	scoredAt: string;
}

/** A cached investigation entry read back from `investigation_cache`. */
export interface CachedFindings {
	findingsJson: string;
	createdAt: string;
}

/** The typed store surface over the central SQLite history. */
export interface Store {
	/** Persist a report: one `runs` row + its exploded `criterion_results`, in one transaction. Returns the new run id. */
	insertRun(report: Report): number;
	/** The most recent run for `repo` (ties broken by insertion order), or `null` if none. */
	latestRun(repo: string): StoredRun | null;
	/** Runs for `repo` scored at or after `since` (ISO-8601), oldest first. */
	runsSince(repo: string, since: string): StoredRun[];
	/** Cached findings for an investigation area at a commit, or `null` on a miss. */
	getCache(repo: string, commitSha: string, area: string): CachedFindings | null;
	/** Upsert cached findings for an investigation area at a commit. */
	putCache(
		repo: string,
		commitSha: string,
		area: string,
		findingsJson: string,
		createdAt: string,
	): void;
	/** Close the underlying database handle. */
	close(): void;
}

/** Shape of a `runs` row as `bun:sqlite` returns it (snake_case columns). */
interface RunRow {
	id: number;
	repo: string;
	commit_sha: string;
	rubric_version: string;
	level: number;
	pass_rate: number;
	coverage: number;
	report_json: string;
	scored_at: string;
}

/** The `runs` columns, in a fixed order, for every SELECT that maps to {@link StoredRun}. */
const RUN_COLUMNS =
	"id, repo, commit_sha, rubric_version, level, pass_rate, coverage, report_json, scored_at";

/** Map a raw {@link RunRow} to the camelCase {@link StoredRun} surface. */
function toStoredRun(row: RunRow): StoredRun {
	return {
		id: row.id,
		repo: row.repo,
		commit: row.commit_sha,
		rubricVersion: row.rubric_version,
		level: row.level as Level,
		passRate: row.pass_rate,
		coverage: row.coverage,
		reportJson: row.report_json,
		scoredAt: row.scored_at,
	};
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

	const insertRunStmt = db.query(
		`INSERT INTO runs (repo, commit_sha, rubric_version, level, pass_rate, coverage, report_json, scored_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const insertCriterionStmt = db.query(
		`INSERT INTO criterion_results (run_id, criterion, numerator, denominator, na_kind, rationale)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	);
	const latestRunStmt = db.query<RunRow, [string]>(
		`SELECT ${RUN_COLUMNS} FROM runs WHERE repo = ? ORDER BY scored_at DESC, id DESC LIMIT 1`,
	);
	const runsSinceStmt = db.query<RunRow, [string, string]>(
		`SELECT ${RUN_COLUMNS} FROM runs WHERE repo = ? AND scored_at >= ? ORDER BY scored_at ASC, id ASC`,
	);
	const getCacheStmt = db.query<
		{ findings_json: string; created_at: string },
		[string, string, string]
	>(
		"SELECT findings_json, created_at FROM investigation_cache WHERE repo = ? AND commit_sha = ? AND area = ?",
	);
	const putCacheStmt = db.query(
		`INSERT INTO investigation_cache (repo, commit_sha, area, findings_json, created_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(repo, commit_sha, area) DO UPDATE SET
		   findings_json = excluded.findings_json,
		   created_at = excluded.created_at`,
	);

	const insertRunTxn = db.transaction((report: Report): number => {
		const result = insertRunStmt.run(
			report.repo,
			report.commit,
			report.rubricVersion,
			report.level,
			report.passRate,
			report.coverage,
			renderJson(report),
			report.scoredAt,
		);
		const runId = Number(result.lastInsertRowid);
		for (const [criterion, entry] of Object.entries(report.criteria)) {
			insertCriterionStmt.run(
				runId,
				criterion,
				entry.numerator,
				entry.denominator,
				(entry.naKind as NaKind | undefined) ?? null,
				entry.rationale,
			);
		}
		return runId;
	});

	return {
		insertRun(report) {
			return insertRunTxn(report);
		},
		latestRun(repo) {
			const row = latestRunStmt.get(repo);
			return row ? toStoredRun(row) : null;
		},
		runsSince(repo, since) {
			return runsSinceStmt.all(repo, since).map(toStoredRun);
		},
		getCache(repo, commitSha, area) {
			const row = getCacheStmt.get(repo, commitSha, area);
			return row ? { findingsJson: row.findings_json, createdAt: row.created_at } : null;
		},
		putCache(repo, commitSha, area, findingsJson, createdAt) {
			putCacheStmt.run(repo, commitSha, area, findingsJson, createdAt);
		},
		close() {
			db.close();
		},
	};
}
