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
 * queries. The transitional investigation-cache API is gone (SPEC §14 stage 3);
 * the historical `investigation_cache` table stays in the append-only
 * migrations, untouched, but nothing reads or writes it.
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

/** One `criterion_results` row joined to its run's `scored_at` — a point on a §11 trend. */
export interface TrendRow {
	criterion: string;
	scoredAt: string;
	numerator: number | null;
	denominator: number;
	naKind: NaKind | null;
}

/** The typed store surface over the central SQLite history. */
export interface Store {
	/** Persist a report: one `runs` row + its exploded `criterion_results`, in one transaction. Returns the new run id. */
	insertRun(report: Report): number;
	/** The most recent run for `repo` (ties broken by insertion order), or `null` if none. */
	latestRun(repo: string): StoredRun | null;
	/** Runs for `repo` scored at or after `since` (ISO-8601), oldest first. */
	runsSince(repo: string, since: string): StoredRun[];
	/** Distinct repo ids with at least one recorded run, sorted ascending (the fleet snapshot universe). */
	repos(): string[];
	/** All runs for `repo` (or those scored at or after `since`), oldest first — the §11 history series. */
	runs(repo: string, since?: string): StoredRun[];
	/** Per-criterion trend points for `repo` (optionally since `since`), ordered oldest run first then criterion id. */
	criterionTrend(repo: string, since?: string): TrendRow[];
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

/** Shape of a joined criterion-trend row as `bun:sqlite` returns it (snake_case columns). */
interface TrendRowRaw {
	criterion: string;
	scored_at: string;
	numerator: number | null;
	denominator: number;
	na_kind: string | null;
}

/** The `runs` columns, in a fixed order, for every SELECT that maps to {@link StoredRun}. */
const RUN_COLUMNS =
	"id, repo, commit_sha, rubric_version, level, pass_rate, coverage, report_json, scored_at";

/** Map a raw joined {@link TrendRowRaw} to the camelCase {@link TrendRow} surface. */
function toTrendRow(row: TrendRowRaw): TrendRow {
	return {
		criterion: row.criterion,
		scoredAt: row.scored_at,
		numerator: row.numerator,
		denominator: row.denominator,
		naKind: (row.na_kind as NaKind | null) ?? null,
	};
}

/**
 * Parse a {@link StoredRun}'s `report_json` back into the §6.3 {@link Report} it
 * was rendered from. The column is always {@link renderJson} output trellis wrote
 * itself, so this is an internal round-trip, not an external boundary — no zod.
 */
export function storedReport(run: StoredRun): Report {
	return JSON.parse(run.reportJson) as Report;
}

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
	const runsAllStmt = db.query<RunRow, [string]>(
		`SELECT ${RUN_COLUMNS} FROM runs WHERE repo = ? ORDER BY scored_at ASC, id ASC`,
	);
	const reposStmt = db.query<{ repo: string }, []>(
		"SELECT DISTINCT repo FROM runs ORDER BY repo ASC",
	);
	const trendColumns =
		"cr.criterion AS criterion, r.scored_at AS scored_at, cr.numerator AS numerator, cr.denominator AS denominator, cr.na_kind AS na_kind";
	const trendOrder = "ORDER BY r.scored_at ASC, r.id ASC, cr.criterion ASC";
	const trendAllStmt = db.query<TrendRowRaw, [string]>(
		`SELECT ${trendColumns} FROM criterion_results cr JOIN runs r ON r.id = cr.run_id WHERE r.repo = ? ${trendOrder}`,
	);
	const trendSinceStmt = db.query<TrendRowRaw, [string, string]>(
		`SELECT ${trendColumns} FROM criterion_results cr JOIN runs r ON r.id = cr.run_id WHERE r.repo = ? AND r.scored_at >= ? ${trendOrder}`,
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
		repos() {
			return reposStmt.all().map((row) => row.repo);
		},
		runs(repo, since) {
			const rows = since === undefined ? runsAllStmt.all(repo) : runsSinceStmt.all(repo, since);
			return rows.map(toStoredRun);
		},
		criterionTrend(repo, since) {
			const rows = since === undefined ? trendAllStmt.all(repo) : trendSinceStmt.all(repo, since);
			return rows.map(toTrendRow);
		},
		close() {
			db.close();
		},
	};
}
