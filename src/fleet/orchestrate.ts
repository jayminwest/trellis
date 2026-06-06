/**
 * Fleet orchestration (SPEC §6.5, §11) — audit every target in a loaded
 * {@link Fleet} sequentially and assemble the aggregate {@link FleetReport}.
 *
 * Each target runs the same core {@link auditRepo} the single-repo CLI does
 * (audit + canonical drift, with the target's `allowedDeltas` and `skip` applied
 * via {@link targetAuditOptions}), persists its run to the central store, and is
 * compared against that repo's *previous* run to surface a level delta (SPEC
 * §11). The previous run is read **before** the new one is inserted, so the delta
 * reflects the prior audit, not the one just written.
 *
 * **Partial-failure isolation:** a target whose path is missing/unreadable, or
 * whose audit throws (e.g. an unbundled canonical version), becomes a per-target
 * error entry — the fleet keeps going and the surviving targets still score and
 * persist. One bad repo never aborts the run.
 *
 * The orchestrator is surface-agnostic core: it takes an injectable store, audit
 * fn, path check, and clock so the whole flow runs offline and deterministically
 * in tests. `now` is pinned across the fleet so every run shares one `scoredAt`.
 */
import { statSync } from "node:fs";
import type { InvestigationDeps } from "../investigation/index.ts";
import { type AuditOptions, auditRepo, type Report } from "../report/index.ts";
import { type Level, RUBRIC_VERSION, type Rubric } from "../rubric/index.ts";
import type { DriftState } from "../standards/index.ts";
import type { Store } from "../store/index.ts";
import {
	type Fleet,
	type FleetDefaults,
	type ResolvedTarget,
	targetAuditOptions,
} from "./targets.ts";

/** A target that scored — its headline metrics plus its level move vs the previous run. */
export interface FleetTargetOk {
	readonly id: string;
	readonly path: string;
	readonly ok: true;
	readonly level: Level;
	readonly passRate: number;
	readonly coverage: number;
	/** Per-state canonical-drift counts, or `null` when no canonical comparison ran. */
	readonly drift: Record<DriftState, number> | null;
	/** This repo's previous run's level, or `null` when this is its first run. */
	readonly previousLevel: Level | null;
	/** `level − previousLevel`, or `null` when there is no prior run (SPEC §11). */
	readonly levelDelta: number | null;
}

/** A target that could not be scored — path missing/unreadable or the audit threw. */
export interface FleetTargetErr {
	readonly id: string;
	readonly path: string;
	readonly ok: false;
	readonly error: string;
}

/** One target's outcome in the aggregate dashboard. */
export type FleetEntry = FleetTargetOk | FleetTargetErr;

/** The aggregate fleet dashboard (SPEC §6.5) — one entry per declared target. */
export interface FleetReport {
	/** ISO-8601 wall-clock shared by every run in this fleet pass. */
	readonly scoredAt: string;
	/** Rubric version every target scored against (SPEC §6.1). */
	readonly rubricVersion: string;
	/** Fleet-default canonical version (per-repo overrides not reflected here), or `null`. */
	readonly canonicalVersion: string | null;
	/** Per-target results, in `targets.yaml` order. */
	readonly entries: readonly FleetEntry[];
	/** Counts of scored vs errored targets, for the headline. */
	readonly summary: { readonly ok: number; readonly error: number };
}

/** Cache + provider wiring and injectable seams for {@link runFleet}. */
export interface FleetRunDeps {
	/** Central store — run history + the investigation cache. The fleet persists every run. */
	readonly store: Store;
	/** Preloaded rubric, shared across targets so it loads once; defaults to the bundled rubric. */
	readonly rubric?: Rubric;
	/** Informational rubric-version pin echoed onto each report (SPEC §12). */
	readonly rubricVersion?: string;
	/** `--no-cache`: force re-investigation for every target. */
	readonly noCache?: boolean;
	/** `pi` binary override passed through to the investigation provider. */
	readonly piBin?: string;
	/** Wall-clock for every run's `scoredAt`, pinned across the fleet; defaults to now. */
	readonly now?: Date;
	/** Injectable audit fn (tests); defaults to the real core {@link auditRepo}. */
	readonly audit?: (repoPath: string, opts: AuditOptions) => Promise<Report>;
	/** Injectable directory check (tests); defaults to a real `statSync` `isDirectory`. */
	readonly pathExists?: (absPath: string) => boolean;
}

/** True iff `absPath` is a readable directory — the real per-target path guard. */
function realPathExists(absPath: string): boolean {
	try {
		return statSync(absPath).isDirectory();
	} catch {
		return false;
	}
}

/** Assemble the per-target {@link AuditOptions}: spec mapping + investigation wiring. */
function buildOptions(
	target: ResolvedTarget,
	defaults: FleetDefaults,
	deps: FleetRunDeps,
	now: Date,
): AuditOptions {
	const investigation: InvestigationDeps = {
		cache: deps.store,
		...(deps.noCache ? { noCache: true } : {}),
		investigateOpts: {
			...(deps.piBin ? { piBin: deps.piBin } : {}),
			...(defaults.investigation ? { targetDefaults: defaults.investigation } : {}),
		},
	};
	return {
		...targetAuditOptions(target, defaults),
		...(deps.rubric ? { rubric: deps.rubric } : {}),
		...(deps.rubricVersion ? { rubricVersion: deps.rubricVersion } : {}),
		now,
		investigation,
	};
}

/** Audit one target, persist its run, and shape its dashboard entry (failures isolated). */
async function runTarget(
	target: ResolvedTarget,
	defaults: FleetDefaults,
	deps: FleetRunDeps,
	audit: (repoPath: string, opts: AuditOptions) => Promise<Report>,
	pathExists: (absPath: string) => boolean,
	now: Date,
): Promise<FleetEntry> {
	const { id } = target.spec;
	const path = target.absPath;
	if (!pathExists(path)) {
		return { id, path, ok: false, error: "path not found or not a directory" };
	}
	// Read the prior run before inserting the new one so the delta reflects it.
	const previous = deps.store.latestRun(id);
	const previousLevel = previous ? previous.level : null;
	try {
		const report = await audit(path, buildOptions(target, defaults, deps, now));
		deps.store.insertRun(report);
		return {
			id,
			path,
			ok: true,
			level: report.level,
			passRate: report.passRate,
			coverage: report.coverage,
			drift: report.drift ? report.drift.summary : null,
			previousLevel,
			levelDelta: previousLevel === null ? null : report.level - previousLevel,
		};
	} catch (error) {
		return { id, path, ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Audit every target in `fleet` sequentially, persisting each run and comparing
 * it against that repo's previous run, then return the aggregate
 * {@link FleetReport}. A per-target failure is isolated into an error entry —
 * the rest of the fleet still scores. `now` is pinned across the whole pass for
 * a deterministic, reproducible dashboard.
 */
export async function runFleet(fleet: Fleet, deps: FleetRunDeps): Promise<FleetReport> {
	const audit = deps.audit ?? auditRepo;
	const pathExists = deps.pathExists ?? realPathExists;
	const now = deps.now ?? new Date();

	const entries: FleetEntry[] = [];
	for (const target of fleet.targets) {
		entries.push(await runTarget(target, fleet.defaults, deps, audit, pathExists, now));
	}

	const ok = entries.filter((e) => e.ok).length;
	return {
		scoredAt: now.toISOString(),
		rubricVersion: deps.rubricVersion ?? RUBRIC_VERSION,
		canonicalVersion: fleet.defaults.canonicalVersion ?? null,
		entries,
		summary: { ok, error: entries.length - ok },
	};
}
