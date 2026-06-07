/**
 * Investigation orchestration for the audit pipeline (SPEC §7.3, §9.5) — the
 * cache-or-investigate seam that turns the four fixed areas into validated
 * findings the grader can score.
 *
 * For each area referenced by a to-be-scored agent criterion, {@link
 * runInvestigation} resolves findings via: `investigation_cache` lookup keyed
 * `(repo, commit_sha, area)` → on miss, a single bounded {@link investigate}
 * run → zod-revalidation → cache write. `--no-cache` forces re-investigation by
 * skipping the lookup (but still writes, so the *next* run is cached). Each area
 * runs **at most once** per audit (SPEC §7.1: bounded LLM cost), regardless of
 * how many criteria consume it.
 *
 * Pi availability is probed **once, and only when there is a miss to fill** — a
 * fully-cached re-run never spawns Pi, so a commit stays auditable even after Pi
 * is uninstalled. A missing/incompatible Pi (or a per-area failure) surfaces as
 * an `ok: false` resolution; the caller maps that to a `no-detector` entry
 * counted against coverage (SPEC §9.6) — **never a fabricated pass**.
 *
 * The cache and the two process boundaries (`investigate`, `probe`) are
 * injectable so the whole flow runs offline against a stubbed provider and a
 * temp DB. The cache surface is structural — the SQLite {@link
 * import("../store/index.ts").Store} satisfies it without this module depending
 * on the store layer.
 */

import type { AreaId } from "./areas.ts";
import { type AreaFindings, FINDINGS_SCHEMAS } from "./findings.ts";
import {
	investigate as defaultInvestigate,
	type InvestigateOpts,
	type InvestigationResult,
	type PiVersionProbe,
	probePiVersion,
	type SessionEvent,
} from "./provider/index.ts";

/**
 * Observability events surfaced by {@link runInvestigation} for the slow agent
 * pass (SPEC §7.3). They never alter control flow — a run with no sink wired is
 * byte-identical (api>cli>sdk: core emits, the CLI renders). Session events are
 * lifted from the Pi RPC loop and tagged with their area.
 */
export type InvestigationEvent =
	| {
			readonly type: "area-start";
			readonly area: AreaId;
			readonly index: number;
			readonly total: number;
	  }
	| { readonly type: "cache-hit"; readonly area: AreaId }
	| { readonly type: "probe"; readonly ok: boolean; readonly detail: string }
	| { readonly type: "session"; readonly area: AreaId; readonly event: SessionEvent }
	| {
			readonly type: "area-end";
			readonly area: AreaId;
			readonly ok: boolean;
			readonly reason?: string;
	  };

/** Optional sink for {@link InvestigationEvent}s; never affects the resolved findings. */
export type InvestigationProgress = (event: InvestigationEvent) => void;

/**
 * The cache surface {@link runInvestigation} needs — exactly the
 * `getCache`/`putCache` pair of the SQLite store, narrowed so this module never
 * imports the store layer. Any `Store` is a valid {@link InvestigationCache}.
 */
export interface InvestigationCache {
	/** Cached findings JSON for `(repo, commitSha, area)`, or `null` on a miss. */
	getCache(
		repo: string,
		commitSha: string,
		area: string,
	): { findingsJson: string; createdAt: string } | null;
	/** Upsert validated findings JSON for `(repo, commitSha, area)`. */
	putCache(
		repo: string,
		commitSha: string,
		area: string,
		findingsJson: string,
		createdAt: string,
	): void;
}

/** Resolved facts for one area, or an honest failure reason (mapped to `no-detector`). */
export type AreaResolution<A extends AreaId = AreaId> =
	| { readonly ok: true; readonly area: A; readonly findings: AreaFindings[A] }
	| { readonly ok: false; readonly area: A; readonly reason: string };

/** Process-boundary signature of {@link investigate}, for test injection. */
export type InvestigateFn = <A extends AreaId>(
	repoPath: string,
	areaId: A,
	opts?: InvestigateOpts,
) => Promise<InvestigationResult<A>>;

/** Identity of the audited checkout — the cache key components plus the run cwd. */
export interface InvestigationContext {
	/** Absolute path to the repo checkout (the `investigate` cwd). */
	readonly repoPath: string;
	/** Repo id used as the cache key — mirrors `Report.repo` (SPEC §6.4). */
	readonly repo: string;
	/** Resolved commit sha (with a `-dirty` suffix for dirty worktrees). */
	readonly commitSha: string;
	/** Timestamp stamped on cache writes (the run's `scoredAt`). */
	readonly createdAt: string;
}

/** Cache + provider wiring for {@link runInvestigation}. */
export interface InvestigationDeps {
	/** Findings cache; absent → every area re-investigates and nothing is persisted. */
	readonly cache?: InvestigationCache;
	/** `--no-cache`: skip the lookup, forcing re-investigation (writes still happen). */
	readonly noCache?: boolean;
	/** Provider/model + binary passthrough to {@link investigate} and the probe. */
	readonly investigateOpts?: InvestigateOpts;
	/** Injectable investigate (default: the real Pi provider). */
	readonly investigate?: InvestigateFn;
	/** Injectable version probe (default: a real `pi --version` probe). */
	readonly probe?: () => Promise<PiVersionProbe>;
	/** Optional observability sink for {@link InvestigationEvent}s (SPEC §7.3 progress). */
	readonly onProgress?: InvestigationProgress;
}

/** Parse cached findings JSON back through the area schema; `null` if corrupt/stale. */
function parseCached<A extends AreaId>(area: A, findingsJson: string): AreaFindings[A] | null {
	let raw: unknown;
	try {
		raw = JSON.parse(findingsJson);
	} catch {
		return null;
	}
	const parsed = FINDINGS_SCHEMAS[area].safeParse(raw);
	return parsed.success ? (parsed.data as AreaFindings[A]) : null;
}

/** A validated cache hit for `area`, or `null` on a miss / disabled cache / corrupt row. */
function cacheHit<A extends AreaId>(
	area: A,
	ctx: InvestigationContext,
	deps: InvestigationDeps,
): AreaFindings[A] | null {
	if (deps.cache === undefined || deps.noCache === true) return null;
	const hit = deps.cache.getCache(ctx.repo, ctx.commitSha, area);
	return hit ? parseCached(area, hit.findingsJson) : null;
}

/** Fill one missed area with a single bounded run; cache a validated success. */
async function fillMiss(
	area: AreaId,
	ctx: InvestigationContext,
	deps: InvestigationDeps,
): Promise<AreaResolution> {
	const investigate = deps.investigate ?? defaultInvestigate;
	const onSession = deps.onProgress
		? (event: SessionEvent) => deps.onProgress?.({ type: "session", area, event })
		: undefined;
	const result = await investigate(ctx.repoPath, area, {
		...(deps.investigateOpts ?? {}),
		...(onSession ? { onSession } : {}),
	});
	if (!result.ok) return { ok: false, area, reason: result.reason };
	deps.cache?.putCache(
		ctx.repo,
		ctx.commitSha,
		area,
		JSON.stringify(result.findings),
		ctx.createdAt,
	);
	return { ok: true, area, findings: result.findings };
}

/**
 * Resolve `areas` to findings for one audited checkout (SPEC §7.3). Cache hits
 * resolve without touching Pi; misses are filled by a single probe + per-area
 * {@link investigate} run, with each success written back to the cache. Returns
 * one {@link AreaResolution} per requested area (insertion order preserved).
 */
export async function runInvestigation(
	areas: readonly AreaId[],
	ctx: InvestigationContext,
	deps: InvestigationDeps,
): Promise<Map<AreaId, AreaResolution>> {
	const out = new Map<AreaId, AreaResolution>();
	const misses: AreaId[] = [];
	const emit = (event: InvestigationEvent): void => deps.onProgress?.(event);

	// Cache pass: a hit (that still validates) resolves immediately; each area
	// runs at most once (SPEC §7.1), so de-dupe before considering it a miss.
	const unique = [...new Set(areas)];
	unique.forEach((area, index) => {
		emit({ type: "area-start", area, index, total: unique.length });
		const cached = cacheHit(area, ctx, deps);
		if (cached !== null) {
			out.set(area, { ok: true, area, findings: cached });
			emit({ type: "cache-hit", area });
			emit({ type: "area-end", area, ok: true });
		} else misses.push(area);
	});

	if (misses.length === 0) return out;

	// Probe Pi exactly once, and only because there is a miss to fill (SPEC §9.6).
	const probe = deps.probe ?? (() => probePiVersion(probeOpts(deps)));
	const probed = await probe();
	emit({
		type: "probe",
		ok: probed.ok,
		detail: probed.ok ? probed.version : probed.reason,
	});
	if (!probed.ok) {
		const reason = `Pi unavailable: ${probed.reason} (${probed.hint})`;
		for (const area of misses) {
			out.set(area, { ok: false, area, reason });
			emit({ type: "area-end", area, ok: false, reason });
		}
		return out;
	}

	for (const area of misses) {
		const resolution = await fillMiss(area, ctx, deps);
		out.set(area, resolution);
		emit({
			type: "area-end",
			area,
			ok: resolution.ok,
			...(resolution.ok ? {} : { reason: resolution.reason }),
		});
	}
	return out;
}

/** Build the probe options from the shared investigate opts (binary override only). */
function probeOpts(deps: InvestigationDeps): { piBin?: string } {
	const piBin = deps.investigateOpts?.piBin;
	return piBin === undefined ? {} : { piBin };
}
