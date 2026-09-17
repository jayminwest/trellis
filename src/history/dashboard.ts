/**
 * History dashboard (SPEC §10, §11, trellis-8366) — the surface-agnostic
 * projection behind `trellis report`. {@link buildHistory} reads the central
 * SQLite store and assembles a {@link HistoryReport} over the **sloppiness
 * audit history**: a snapshot of every repo's latest audit run, and per-repo
 * scored-basis-compatible index series (§3.5, §16.6).
 *
 * **Legacy separation (SPEC §10).** Legacy readiness runs survive in the same
 * database and surface here as a visibly distinct `legacy` section — repo,
 * run count, and the latest readiness numbers, labeled as a different
 * product. Readiness percentages and levels are **never** compared with,
 * averaged into, or trended against sloppiness indices: the two sections
 * share no series, no scale, and no delta.
 *
 * **Compatible trends (SPEC §3.5, §16.6).** A repo's series anchors on its
 * latest run and selects every stored run whose scored basis is comparable
 * with that anchor — the step-6 verdicts reused over the stored JSON
 * provenance, never a re-derived rule. An advisory-only provider change
 * (added, removed, upgraded optional provider) never fragments a series; a
 * changed scored measurement or scoring basis starts a distinct, clearly
 * marked series (the snapshot's index move reads `new` again, and the old
 * runs never silently join it). The snapshot's index delta compares the
 * latest two compatible runs (positive = worse; lower is better).
 *
 * The whole report is pure over the store, so tests seed a `:memory:`/temp
 * DB and assert the projection.
 */
import type { AuditReport, Completeness } from "../contract/index.ts";
import type { Store, StoredAuditRun, StoredRun } from "../store/index.ts";
import { decodedStoredReport } from "../store/index.ts";

/** One repo's headline state in the sloppiness snapshot (its most recent audit run). */
export interface AuditSnapshotEntry {
	/** Repository identity (`<label>#<hash>`, SPEC §10). */
	repo: string;
	/** The 0–100 sloppiness index (lower is better) of the latest run. */
	index: number;
	/** True when the latest run's headline is flagged partial (§3.4). */
	partial: boolean;
	completeness: Completeness;
	scoringVersion: string;
	auditedAt: string;
	/** Total audit runs recorded for this repo within the report's `since` window. */
	runs: number;
	/** `index − previous compatible run's index` (positive = worse), or `null` on a first run. */
	indexDelta: number | null;
}

/** One point on a repo's scored-basis-compatible sloppiness series. */
export interface AuditRunPoint {
	auditedAt: string;
	index: number;
	partial: boolean;
	completeness: Completeness;
	scoringVersion: string;
}

/** Per-repo sloppiness detail: the compatible run series, oldest first. */
export interface AuditRepoHistory {
	repo: string;
	runs: AuditRunPoint[];
}

/**
 * One repo's legacy readiness history, visibly distinct (SPEC §10): a
 * different product's numbers, never trended against the sloppiness index.
 */
export interface LegacyRepoEntry {
	repo: string;
	/** Total legacy readiness runs recorded within the report's `since` window. */
	runs: number;
	latestLevel: number;
	latestPassRate: number;
	latestCoverage: number;
	latestRubricVersion: string;
	latestScoredAt: string;
}

/** The `trellis report` document (SPEC §10, §11) — sloppiness history + the distinct legacy section. */
export interface HistoryReport {
	/** The query scope echoed back: a single repo or all, and the `since` floor. */
	scope: { repo: string | null; since: string | null };
	/** Sloppiness audit history (the pivoted product). */
	audits: {
		/** Latest audit run per repo in scope, sorted by repo identity. */
		snapshot: AuditSnapshotEntry[];
		/** Per-repo compatible index series for every repo with a run in the window. */
		repos: AuditRepoHistory[];
	};
	/** Legacy readiness history — a different scale, never compared (SPEC §10). */
	legacy: LegacyRepoEntry[];
}

/** Options for {@link buildHistory} — both narrow the query (SPEC §12 flags). */
export interface HistoryOptions {
	/** Limit to one repo identity; absent → every repo with recorded runs. */
	repo?: string;
	/** Only runs audited/scored at or after this ISO-8601 instant; absent → all history. */
	since?: string;
}

/** Project a {@link StoredAuditRun} onto an {@link AuditRunPoint} for the series. */
function toRunPoint(run: StoredAuditRun): AuditRunPoint {
	return {
		auditedAt: run.auditedAt,
		index: run.sloppinessIndex,
		partial: run.partial,
		completeness: run.completeness,
		scoringVersion: run.scoringVersion,
	};
}

/**
 * Build one repo's snapshot row: the latest run's headline plus the index
 * move against the previous scored-basis-compatible run (`null` on a first
 * run — and on a series restart: a changed scored basis never trends
 * across the change).
 */
function snapshotEntry(
	store: Store,
	latest: StoredAuditRun,
	anchor: AuditReport | null,
	runCount: number,
): AuditSnapshotEntry {
	const compatible = anchor === null ? [] : store.compatibleAuditRuns(latest.repoIdentity, anchor);
	const previous = compatible.length >= 2 ? compatible[compatible.length - 2] : undefined;
	return {
		repo: latest.repoIdentity,
		index: latest.sloppinessIndex,
		partial: latest.partial,
		completeness: latest.completeness,
		scoringVersion: latest.scoringVersion,
		auditedAt: latest.auditedAt,
		runs: runCount,
		indexDelta: previous === undefined ? null : latest.sloppinessIndex - previous.sloppinessIndex,
	};
}

/** Assemble one repo's compatible series, or `null` when it has no run in the window. */
function repoHistory(
	store: Store,
	latest: StoredAuditRun,
	anchor: AuditReport | null,
	since: string | undefined,
): AuditRepoHistory | null {
	if (anchor === null) return null;
	const runs = store.compatibleAuditRuns(latest.repoIdentity, anchor, since);
	if (runs.length === 0) return null;
	return { repo: latest.repoIdentity, runs: runs.map(toRunPoint) };
}

/** Build one repo's legacy readiness entry from its latest legacy run (SPEC §10 — distinct scale). */
function legacyEntry(latest: StoredRun, runCount: number): LegacyRepoEntry {
	return {
		repo: latest.repo,
		runs: runCount,
		latestLevel: latest.level,
		latestPassRate: latest.passRate,
		latestCoverage: latest.coverage,
		latestRubricVersion: latest.rubricVersion,
		latestScoredAt: latest.scoredAt,
	};
}

/**
 * Build the `trellis report` dashboard from the central history. The
 * sloppiness snapshot reflects each repo's most recent audit run overall
 * (where things stand now), while the per-repo series anchor on that latest
 * run's decoded provenance and honor the `since` window and the scored-basis
 * compatibility rules. A latest row that does not decode (a foreign writer)
 * still headlines the snapshot but has no comparable series and no index
 * delta — unknown provenance never implies compatibility. A `--repo` filter
 * narrows both sections to a single repo; a repo with no run in the window is
 * dropped from the series but still shown in the snapshot if it has any
 * latest run. Legacy readiness repos surface only in the distinct `legacy`
 * section.
 */
export function buildHistory(store: Store, opts: HistoryOptions = {}): HistoryReport {
	const auditRepos = opts.repo ? [opts.repo] : store.auditRepos();
	const snapshot: AuditSnapshotEntry[] = [];
	const repos: AuditRepoHistory[] = [];
	for (const identity of auditRepos) {
		const latest = store.latestAuditRun(identity);
		if (!latest) continue;
		const anchor = decodedStoredReport(latest);
		snapshot.push(
			snapshotEntry(store, latest, anchor, store.auditRuns(identity, opts.since).length),
		);
		const detail = repoHistory(store, latest, anchor, opts.since);
		if (detail) repos.push(detail);
	}

	const legacyRepos = opts.repo ? [opts.repo] : store.repos();
	const legacy: LegacyRepoEntry[] = [];
	for (const repo of legacyRepos) {
		const latest = store.latestRun(repo);
		if (latest) legacy.push(legacyEntry(latest, store.runs(repo, opts.since).length));
	}

	return {
		scope: { repo: opts.repo ?? null, since: opts.since ?? null },
		audits: { snapshot, repos },
		legacy,
	};
}
