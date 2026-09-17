/**
 * Sloppiness-audit history (SPEC §10, trellis-424d) — the typed store
 * operations over the `audit_runs` table (migration 0002), composed into the
 * central {@link import("./store.ts").Store} by `openStore`.
 *
 * **Legacy separation (SPEC §10).** New deterministic audits persist here;
 * legacy readiness runs stay in the legacy `runs`/`criterion_results` tables
 * behind the legacy API. The two never form a mixed score trend: every query
 * in this module reads `audit_runs` only, and every row is tagged
 * `kind: "sloppiness"` (legacy rows carry `kind: "legacy-readiness"`), so a
 * view can label the product a number belongs to. Readiness percentages and
 * sloppiness indices are never compared, averaged, or trended together.
 *
 * **Repository identity (SPEC §10).** {@link repoIdentity} derives a
 * collision-resistant identity from the canonical workspace root: a
 * human-readable label (the report's declared identity, else the directory
 * basename) plus a SHA-256 hash prefix of the canonical absolute path. Two
 * unrelated directories that share a basename hash differently, so their
 * histories can never collide; the same checkout reached through different
 * spellings or symlinks canonicalizes to one identity. No Git, no network —
 * identity is a pure function of the filesystem path.
 *
 * **Compatible trends (SPEC §3.5, §10).** Trend queries select only runs
 * whose schema, analyzer, and scoring versions all match the requested
 * versions — the persistence-level half of the §3.5 comparability rule.
 * Metric-set and configuration compatibility are decidable only from report
 * artifacts and remain the comparator's job (`src/compare/`).
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { AuditReport, Completeness } from "../contract/index.ts";
import { renderAuditJson } from "../report/audit-json.ts";

/** The §3.5 version triple a trend query matches on (SPEC §3.5). */
export interface ReportVersions {
	schemaVersion: string;
	analyzerVersion: string;
	scoringVersion: string;
}

/** A row read back from `audit_runs`, with columns mapped to camelCase. */
export interface StoredAuditRun {
	/** Product discriminator — visibly distinct from legacy readiness history (SPEC §10). */
	kind: "sloppiness";
	id: number;
	repoRoot: string;
	repoIdentity: string;
	schemaVersion: string;
	analyzerVersion: string;
	scoringVersion: string;
	/** The 0–100 sloppiness index (lower is better) — never a readiness percentage. */
	sloppinessIndex: number;
	partial: boolean;
	completeness: Completeness;
	reportJson: string;
	auditedAt: string;
}

/** One point on a repo's sloppiness trend — same-scale indices only (SPEC §10). */
export interface SloppinessTrendPoint {
	auditedAt: string;
	index: number;
	partial: boolean;
	completeness: Completeness;
}

/** The typed store surface over the `audit_runs` history. */
export interface AuditStore {
	/**
	 * Persist a §6.4 report: one `audit_runs` row. The report is re-validated
	 * and serialized via {@link renderAuditJson}, so two audits with an equal
	 * measurement payload and pinned `auditedAt` persist identical JSON.
	 * Returns the new run id.
	 */
	insertAuditRun(report: AuditReport): number;
	/** The most recent audit run for `identity` (ties broken by insertion order), or `null`. */
	latestAuditRun(identity: string): StoredAuditRun | null;
	/** All audit runs for `identity` (optionally since `since`), oldest first. */
	auditRuns(identity: string, since?: string): StoredAuditRun[];
	/**
	 * The §3.5-compatible run series for `identity`: only runs whose schema,
	 * analyzer, and scoring versions all match `versions`, oldest first.
	 * Incompatible runs are excluded, never silently trended.
	 */
	compatibleAuditRuns(identity: string, versions: ReportVersions, since?: string): StoredAuditRun[];
	/**
	 * The most recent §3.5-compatible run for `identity` — the prior-run
	 * selection for baseline comparison (SPEC §9). Consumers read it before
	 * inserting the new run (the legacy path's read-before-write pattern).
	 */
	latestCompatibleRun(identity: string, versions: ReportVersions): StoredAuditRun | null;
	/** The compatible sloppiness-index series for `identity`, oldest first. */
	sloppinessTrend(
		identity: string,
		versions: ReportVersions,
		since?: string,
	): SloppinessTrendPoint[];
	/** Distinct repository identities with at least one recorded audit run, sorted ascending. */
	auditRepos(): string[];
}

/** Shape of an `audit_runs` row as `bun:sqlite` returns it (snake_case columns). */
interface AuditRunRow {
	id: number;
	repo_root: string;
	repo_identity: string;
	schema_version: string;
	analyzer_version: string;
	scoring_version: string;
	sloppiness_index: number;
	partial: number;
	completeness: string;
	report_json: string;
	audited_at: string;
}

/** The `audit_runs` columns, in a fixed order, for every SELECT that maps to {@link StoredAuditRun}. */
const AUDIT_RUN_COLUMNS =
	"id, repo_root, repo_identity, schema_version, analyzer_version, scoring_version, " +
	"sloppiness_index, partial, completeness, report_json, audited_at";

/** The WHERE clause selecting §3.5-compatible runs (all three versions match). */
const COMPATIBLE_WHERE =
	"repo_identity = ? AND schema_version = ? AND analyzer_version = ? AND scoring_version = ?";

/** Map a raw {@link AuditRunRow} to the camelCase {@link StoredAuditRun} surface. */
function toStoredAuditRun(row: AuditRunRow): StoredAuditRun {
	return {
		kind: "sloppiness",
		id: row.id,
		repoRoot: row.repo_root,
		repoIdentity: row.repo_identity,
		schemaVersion: row.schema_version,
		analyzerVersion: row.analyzer_version,
		scoringVersion: row.scoring_version,
		sloppinessIndex: row.sloppiness_index,
		partial: row.partial !== 0,
		completeness: row.completeness as Completeness,
		reportJson: row.report_json,
		auditedAt: row.audited_at,
	};
}

/**
 * Parse a {@link StoredAuditRun}'s `report_json` back into the §6.4
 * {@link AuditReport} it was rendered from. The column is always
 * {@link renderAuditJson} output trellis wrote itself, so this is an internal
 * round-trip, not an external boundary — no zod.
 */
export function storedAuditReport(run: StoredAuditRun): AuditReport {
	return JSON.parse(run.reportJson) as AuditReport;
}

/** The canonical absolute form of a workspace root: resolved, symlinks followed when it exists. */
function canonicalRoot(root: string): string {
	const absolute = resolve(root);
	try {
		return realpathSync(absolute);
	} catch {
		return absolute;
	}
}

/**
 * Derive the collision-resistant repository identity for a workspace root
 * (SPEC §10): `<label>#<sha256(canonical root)[:12]>`, where the label is the
 * report's declared identity (the root manifest's `name`) when present, else
 * the directory basename. The hash is over the canonical absolute path, so
 * unrelated directories that share a basename — or even a package name —
 * never collide, while one checkout reached through different spellings or
 * symlinks keeps a single identity. Pure filesystem function: no Git.
 */
export function repoIdentity(root: string, declaredIdentity?: string): string {
	const canonical = canonicalRoot(root);
	const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
	const label = declaredIdentity ?? basename(canonical);
	return `${label}#${hash}`;
}

/** The §3.5 version triple of a report, for compatible-run queries. */
export function reportVersions(report: AuditReport): ReportVersions {
	return {
		schemaVersion: report.schemaVersion,
		analyzerVersion: report.analyzerVersion,
		scoringVersion: report.scoringVersion,
	};
}

/**
 * Build the {@link AuditStore} over an already-open, already-migrated
 * database. Composed into the central store by `openStore` — never call this
 * with an unmigrated handle.
 */
export function auditStore(db: Database): AuditStore {
	const insertStmt = db.query(
		`INSERT INTO audit_runs
		 (repo_root, repo_identity, schema_version, analyzer_version, scoring_version,
		  sloppiness_index, partial, completeness, report_json, audited_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const latestStmt = db.query<AuditRunRow, [string]>(
		`SELECT ${AUDIT_RUN_COLUMNS} FROM audit_runs
		 WHERE repo_identity = ? ORDER BY audited_at DESC, id DESC LIMIT 1`,
	);
	const runsAllStmt = db.query<AuditRunRow, [string]>(
		`SELECT ${AUDIT_RUN_COLUMNS} FROM audit_runs
		 WHERE repo_identity = ? ORDER BY audited_at ASC, id ASC`,
	);
	const runsSinceStmt = db.query<AuditRunRow, [string, string]>(
		`SELECT ${AUDIT_RUN_COLUMNS} FROM audit_runs
		 WHERE repo_identity = ? AND audited_at >= ? ORDER BY audited_at ASC, id ASC`,
	);
	const compatibleAllStmt = db.query<AuditRunRow, [string, string, string, string]>(
		`SELECT ${AUDIT_RUN_COLUMNS} FROM audit_runs
		 WHERE ${COMPATIBLE_WHERE} ORDER BY audited_at ASC, id ASC`,
	);
	const compatibleSinceStmt = db.query<AuditRunRow, [string, string, string, string, string]>(
		`SELECT ${AUDIT_RUN_COLUMNS} FROM audit_runs
		 WHERE ${COMPATIBLE_WHERE} AND audited_at >= ? ORDER BY audited_at ASC, id ASC`,
	);
	const latestCompatibleStmt = db.query<AuditRunRow, [string, string, string, string]>(
		`SELECT ${AUDIT_RUN_COLUMNS} FROM audit_runs
		 WHERE ${COMPATIBLE_WHERE} ORDER BY audited_at DESC, id DESC LIMIT 1`,
	);
	const reposStmt = db.query<{ repo_identity: string }, []>(
		"SELECT DISTINCT repo_identity FROM audit_runs ORDER BY repo_identity ASC",
	);

	const toTrendPoint = (run: StoredAuditRun): SloppinessTrendPoint => ({
		auditedAt: run.auditedAt,
		index: run.sloppinessIndex,
		partial: run.partial,
		completeness: run.completeness,
	});
	const compatibleRuns = (
		identity: string,
		versions: ReportVersions,
		since?: string,
	): StoredAuditRun[] => {
		const params: [string, string, string, string] = [
			identity,
			versions.schemaVersion,
			versions.analyzerVersion,
			versions.scoringVersion,
		];
		const rows =
			since === undefined
				? compatibleAllStmt.all(...params)
				: compatibleSinceStmt.all(...params, since);
		return rows.map(toStoredAuditRun);
	};

	return {
		insertAuditRun(report) {
			const result = insertStmt.run(
				report.repo.root,
				repoIdentity(report.repo.root, report.repo.identity),
				report.schemaVersion,
				report.analyzerVersion,
				report.scoringVersion,
				report.score.index,
				report.score.partial ? 1 : 0,
				report.completeness,
				renderAuditJson(report),
				report.run?.auditedAt ?? new Date().toISOString(),
			);
			return Number(result.lastInsertRowid);
		},
		latestAuditRun(identity) {
			const row = latestStmt.get(identity);
			return row ? toStoredAuditRun(row) : null;
		},
		auditRuns(identity, since) {
			const rows =
				since === undefined ? runsAllStmt.all(identity) : runsSinceStmt.all(identity, since);
			return rows.map(toStoredAuditRun);
		},
		compatibleAuditRuns: compatibleRuns,
		latestCompatibleRun(identity, versions) {
			const row = latestCompatibleStmt.get(
				identity,
				versions.schemaVersion,
				versions.analyzerVersion,
				versions.scoringVersion,
			);
			return row ? toStoredAuditRun(row) : null;
		},
		sloppinessTrend(identity, versions, since) {
			return compatibleRuns(identity, versions, since).map(toTrendPoint);
		},
		auditRepos() {
			return reposStmt.all().map((row) => row.repo_identity);
		},
	};
}
