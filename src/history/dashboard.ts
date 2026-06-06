/**
 * History dashboard (SPEC §11) — the surface-agnostic projection behind
 * `trellis report`. {@link buildHistory} reads the central SQLite store and
 * assembles a {@link HistoryReport}: a fleet snapshot of every repo's latest run,
 * and per-repo detail — the level/pass-rate/coverage series over time, the
 * latest run's embedded `changesSinceLastRun` delta, and the per-criterion trends
 * powered by `criterion_results`.
 *
 * It computes nothing the store can't answer with a query: the fleet snapshot's
 * level delta comes straight off each latest run's embedded §11 delta (no extra
 * read), and trends are folded from the joined criterion rows. The whole thing is
 * pure over the store, so tests seed a `:memory:`/temp DB and assert the report.
 */
import {
	type ChangesSinceLastRun,
	type CriterionSnapshot,
	criterionStatus,
} from "../report/index.ts";
import type { Level } from "../rubric/index.ts";
import { RUBRIC_VERSION } from "../rubric/index.ts";
import type { NaKind } from "../scoring/index.ts";
import { type Store, type StoredRun, storedReport, type TrendRow } from "../store/index.ts";

/** One repo's headline state in the fleet snapshot (its most recent run). */
export interface SnapshotEntry {
	repo: string;
	level: Level;
	passRate: number;
	coverage: number;
	rubricVersion: string;
	commit: string;
	scoredAt: string;
	/** Net level move of the latest run vs its predecessor, or `null` on a first run. */
	levelDelta: number | null;
	/** Total runs recorded for this repo within the report's `since` window. */
	runs: number;
}

/** One point on a repo's level/pass-rate/coverage series. */
export interface RunPoint {
	scoredAt: string;
	commit: string;
	rubricVersion: string;
	level: Level;
	passRate: number;
	coverage: number;
}

/** One point on a single criterion's trend. */
export interface TrendPoint {
	scoredAt: string;
	status: CriterionSnapshot["status"];
	numerator: number | null;
	denominator: number;
	naKind: NaKind | null;
}

/** A criterion that moved at least once across the window, with its full point series. */
export interface CriterionTrend {
	criterion: string;
	points: TrendPoint[];
}

/** Per-repo detail: the run series, the latest §11 delta, and the moved-criterion trends. */
export interface RepoHistory {
	repo: string;
	/** Run series oldest → newest within the `since` window. */
	runs: RunPoint[];
	/** The latest run's embedded §11 delta, or `null` (a first run, or a det-only history). */
	changesSinceLastRun: ChangesSinceLastRun | null;
	/** Only criteria whose measured state changed at least once across the window. */
	trends: CriterionTrend[];
}

/** The `trellis report` document (SPEC §11) — fleet snapshot + per-repo history. */
export interface HistoryReport {
	/** The currently-bundled rubric version (what a fresh audit would score against). */
	rubricVersion: string;
	/** The query scope echoed back: a single repo or all, and the `since` floor. */
	scope: { repo: string | null; since: string | null };
	/** Latest run per repo in scope, sorted by repo id. */
	fleet: SnapshotEntry[];
	/** Per-repo detail for every repo in scope that has a run in the window. */
	repos: RepoHistory[];
}

/** Options for {@link buildHistory} — both narrow the query (SPEC §12 flags). */
export interface HistoryOptions {
	/** Limit to one repo id; absent → every repo with recorded runs. */
	repo?: string;
	/** Only runs scored at or after this ISO-8601 instant; absent → all history. */
	since?: string;
}

/** Project a {@link StoredRun} onto a {@link RunPoint} for the series. */
function toRunPoint(run: StoredRun): RunPoint {
	return {
		scoredAt: run.scoredAt,
		commit: run.commit,
		rubricVersion: run.rubricVersion,
		level: run.level,
		passRate: run.passRate,
		coverage: run.coverage,
	};
}

/** The latest run's embedded §11 delta, or `null` when none was recorded. */
function latestDelta(latest: StoredRun): ChangesSinceLastRun | null {
	return storedReport(latest).changesSinceLastRun ?? null;
}

/** Build one repo's fleet-snapshot row from its latest run and windowed run count. */
function snapshotEntry(latest: StoredRun, runCount: number): SnapshotEntry {
	return {
		repo: latest.repo,
		level: latest.level,
		passRate: latest.passRate,
		coverage: latest.coverage,
		rubricVersion: latest.rubricVersion,
		commit: latest.commit,
		scoredAt: latest.scoredAt,
		levelDelta: latestDelta(latest)?.netLevelMove ?? null,
		runs: runCount,
	};
}

/** A trend point is two snapshots that differ in any measured field. */
function pointsDiffer(a: TrendPoint, b: TrendPoint): boolean {
	return (
		a.status !== b.status ||
		a.numerator !== b.numerator ||
		a.denominator !== b.denominator ||
		a.naKind !== b.naKind
	);
}

/** Map a joined {@link TrendRow} to a {@link TrendPoint}, folding its status. */
function toTrendPoint(row: TrendRow): TrendPoint {
	const entry =
		row.naKind === null
			? { numerator: row.numerator, denominator: row.denominator, rationale: "" }
			: {
					numerator: row.numerator,
					denominator: row.denominator,
					rationale: "",
					naKind: row.naKind,
				};
	return {
		scoredAt: row.scoredAt,
		status: criterionStatus(entry),
		numerator: row.numerator,
		denominator: row.denominator,
		naKind: row.naKind,
	};
}

/**
 * Fold the joined criterion rows (oldest run first, then criterion id) into
 * per-criterion trends, keeping only criteria that moved at least once. First-seen
 * criterion order is preserved so the output is deterministic.
 */
function buildTrends(rows: TrendRow[]): CriterionTrend[] {
	const byCriterion = new Map<string, TrendPoint[]>();
	for (const row of rows) {
		const points = byCriterion.get(row.criterion) ?? [];
		points.push(toTrendPoint(row));
		byCriterion.set(row.criterion, points);
	}
	const trends: CriterionTrend[] = [];
	for (const [criterion, points] of byCriterion) {
		const moved = points.some((p, i) => i > 0 && pointsDiffer(p, points[i - 1] as TrendPoint));
		if (moved) trends.push({ criterion, points });
	}
	return trends;
}

/** Assemble one repo's detail section, or `null` when it has no run in the window. */
function repoHistory(store: Store, repo: string, since: string | undefined): RepoHistory | null {
	const runs = store.runs(repo, since);
	if (runs.length === 0) return null;
	const latest = runs[runs.length - 1] as StoredRun;
	return {
		repo,
		runs: runs.map(toRunPoint),
		changesSinceLastRun: latestDelta(latest),
		trends: buildTrends(store.criterionTrend(repo, since)),
	};
}

/**
 * Build the `trellis report` dashboard from the central history. The fleet
 * snapshot reflects each repo's most recent run overall (where things stand now),
 * while the per-repo run series and trends honor the `since` window. A `--repo`
 * filter narrows both to a single repo; a repo with no run in the window is
 * dropped from `repos` but still shown in the snapshot if it has any latest run.
 */
export function buildHistory(store: Store, opts: HistoryOptions = {}): HistoryReport {
	const repoIds = opts.repo ? [opts.repo] : store.repos();

	const fleet: SnapshotEntry[] = [];
	const repos: RepoHistory[] = [];
	for (const repo of repoIds) {
		const latest = store.latestRun(repo);
		if (latest) fleet.push(snapshotEntry(latest, store.runs(repo, opts.since).length));
		const detail = repoHistory(store, repo, opts.since);
		if (detail) repos.push(detail);
	}

	return {
		rubricVersion: RUBRIC_VERSION,
		scope: { repo: opts.repo ?? null, since: opts.since ?? null },
		fleet,
		repos,
	};
}
