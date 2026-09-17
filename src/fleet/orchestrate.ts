/**
 * Fleet orchestration (SPEC §11, trellis-8366) — audit every target in a
 * loaded {@link Fleet} sequentially through the **same deterministic core** a
 * single-repo run uses, and assemble the aggregate {@link FleetReport}.
 *
 * Each target folds {@link runWorkspaceAudit} — the exact service the CLI's
 * `trellis audit` and the SDK's `audit()` call — so a fleet audit and an
 * independent core audit of the same workspace can never drift (the tests
 * prove the measurement payloads are deep-equal). The entry preserves the
 * target's whole §6.4 report (findings, completeness, metrics) plus the
 * declarative §9 policy assessment over the target's own configuration;
 * nothing is re-aggregated or re-scored at the fleet level.
 *
 * **Standards drift stays a separate capability (SPEC §11).** Each target
 * also runs {@link driftRepo} with its `canonical` options, and the per-state
 * counts ride along on the entry — but drift never enters the sloppiness
 * index, the policy assessment, or the fleet exit policy. A drift failure
 * (e.g. an unbundled canonical version) degrades to `driftError` on an
 * otherwise healthy entry; it never eats the audit.
 *
 * **Partial-failure isolation:** a target whose path is missing/unreadable,
 * or whose audit throws (e.g. an invalid `trellis.yaml`), becomes a
 * per-target error entry — the fleet keeps going and the surviving targets
 * still score. One bad repo never aborts the run.
 *
 * **Per-target provider scope (SPEC §16, plan `pl-43c5` step 20 —
 * trellis-f3e5).** Optional provider selection rides each target's own
 * configuration (the `providers` block of its `trellis.yaml` or explicit
 * `config`) through the same core service — the fleet holds no provider
 * logic, planning or policy of its own. Because every target folds its own
 * isolated `runWorkspaceAudit` call, nothing provider-related is shared
 * across targets: each request stages its own source view under trellis-owned
 * scratch (a fresh `mkdtemp` per analysis, cleaned on every exit path — a
 * neighbor's failure, unavailability or cleanup problem cannot touch it),
 * resolves its own pinned tool, and carries its own namespaced, unscored
 * evidence on its own report. A target that requests no provider stays
 * byte-identical to a native-only audit, and provider evidence never enters
 * the index, the summary counts or the exit rollup — mixed situations (one
 * target with complete evidence, one unavailable, one unrequested) stay
 * explicit per entry instead of being summed or averaged into anything
 * score-like. The fleet stays sequential (bounded concurrency of one, no
 * scheduling service): each target's staged-scratch lifecycle is fully
 * awaited inside its own audit before the next target starts, so two
 * targets can never share or race on a scratch path, and per-target
 * cancellation/cleanup semantics are exactly the single-audit core's.
 *
 * **Stateless by default (SPEC §8, §10).** Persistence is opt-in: with
 * `history` on, each target's run appends to the central audit history and
 * the entry carries the index move against the repo's previous compatible
 * run; without it the fleet opens no database.
 *
 * The orchestrator is surface-agnostic core: it takes an injectable audit
 * service, drift fn, path check, and clock so the whole flow runs offline
 * and deterministically in tests. `now` is pinned across the fleet so every
 * entry shares one `auditedAt`.
 */
import { statSync } from "node:fs";
import {
	runWorkspaceAudit,
	type WorkspaceAuditOptions,
	type WorkspaceAuditResult,
} from "../audit/index.ts";
import type { PolicyAssessment } from "../compare/index.ts";
import type { AuditReport } from "../contract/index.ts";
import {
	type DriftOptions,
	type DriftReport,
	type DriftState,
	driftRepo,
} from "../standards/index.ts";
import {
	type Fleet,
	type FleetDefaults,
	type ResolvedTarget,
	targetDriftOptions,
} from "./targets.ts";

/** A target that audited — its full §6.4 report, policy assessment, and non-scoring drift counts. */
export interface FleetTargetOk {
	readonly id: string;
	readonly path: string;
	readonly ok: true;
	/** The §6.4 report the deterministic core assembled — findings and completeness preserved whole. */
	readonly report: AuditReport;
	/** The independent §9 policy evaluation over the target's own configuration. */
	readonly policy: PolicyAssessment;
	/** Per-state canonical-drift counts (separate capability, never scored), or `null` when drift did not run. */
	readonly drift: Record<DriftState, number> | null;
	/** The drift failure, when the drift comparison itself could not run (the audit still stands). */
	readonly driftError: string | null;
	/** The previous compatible stored run's index, or `null` (no history, or a first run). */
	readonly previousIndex: number | null;
	/** `index − previousIndex` (positive = worse; lower is better), or `null` without a prior run. */
	readonly indexDelta: number | null;
}

/** A target that could not be audited — path missing/unreadable or the audit threw. */
export interface FleetTargetErr {
	readonly id: string;
	readonly path: string;
	readonly ok: false;
	readonly error: string;
}

/** One target's outcome in the aggregate report. */
export type FleetEntry = FleetTargetOk | FleetTargetErr;

/** The aggregate fleet report (SPEC §11) — one entry per declared target. */
export interface FleetReport {
	/** ISO-8601 wall-clock shared by every audit in this fleet pass. */
	readonly auditedAt: string;
	/** Per-target results, in `targets.yaml` order. */
	readonly entries: readonly FleetEntry[];
	/** Counts of audited vs errored targets, and how many audits tripped their policy. */
	readonly summary: {
		readonly ok: number;
		readonly error: number;
		readonly policyFailed: number;
	};
}

/** Injectable seams for {@link runFleet}. */
export interface FleetRunDeps {
	/**
	 * Injectable audit service (tests); defaults to the real
	 * {@link runWorkspaceAudit} — the same service the CLI and SDK fold.
	 */
	readonly audit?: (root: string, opts: WorkspaceAuditOptions) => Promise<WorkspaceAuditResult>;
	/** Injectable drift fn (tests); defaults to the real {@link driftRepo}. */
	readonly drift?: (repoPath: string, opts: DriftOptions) => DriftReport;
	/** Injectable directory check (tests); defaults to a real `statSync` `isDirectory`. */
	readonly pathExists?: (absPath: string) => boolean;
	/** Wall-clock for every audit's `run.auditedAt`, pinned across the fleet; defaults to now. */
	readonly now?: Date;
	/** Opt-in persistence (SPEC §10): record each run and resolve a stored baseline. Default false. */
	readonly history?: boolean;
	/** SQLite history path (meaningful only with `history`); defaults to `$TRELLIS_DB` or `~/.trellis/trellis.db`. */
	readonly db?: string;
}

/** True iff `absPath` is a readable directory — the real per-target path guard. */
function realPathExists(absPath: string): boolean {
	try {
		return statSync(absPath).isDirectory();
	} catch {
		return false;
	}
}

/** Run the separate drift capability for one target, isolating its failure from the audit. */
function runDrift(
	target: ResolvedTarget,
	defaults: FleetDefaults,
	drift: (repoPath: string, opts: DriftOptions) => DriftReport,
): { summary: Record<DriftState, number> | null; error: string | null } {
	try {
		return {
			summary: drift(target.absPath, targetDriftOptions(target, defaults)).summary,
			error: null,
		};
	} catch (error) {
		return { summary: null, error: error instanceof Error ? error.message : String(error) };
	}
}

/** Audit one target through the deterministic core and shape its entry (failures isolated). */
async function runTarget(
	target: ResolvedTarget,
	defaults: FleetDefaults,
	audit: (root: string, opts: WorkspaceAuditOptions) => Promise<WorkspaceAuditResult>,
	drift: (repoPath: string, opts: DriftOptions) => DriftReport,
	pathExists: (absPath: string) => boolean,
	deps: FleetRunDeps,
	now: Date,
): Promise<FleetEntry> {
	const { id } = target.spec;
	const path = target.absPath;
	if (!pathExists(path)) {
		return { id, path, ok: false, error: "path not found or not a directory" };
	}
	try {
		const result = await audit(path, {
			...(target.absConfigPath === undefined ? {} : { configPath: target.absConfigPath }),
			...(deps.history === true ? { history: true } : {}),
			...(deps.history === true && deps.db !== undefined ? { db: deps.db } : {}),
			now,
		});
		const driftResult = runDrift(target, defaults, drift);
		const previousIndex = result.baseline?.score.index ?? null;
		return {
			id,
			path,
			ok: true,
			report: result.report,
			policy: result.policy,
			drift: driftResult.summary,
			driftError: driftResult.error,
			previousIndex,
			indexDelta: previousIndex === null ? null : result.report.score.index - previousIndex,
		};
	} catch (error) {
		return { id, path, ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Audit every target in `fleet` sequentially through the deterministic core
 * and return the aggregate {@link FleetReport} (see the module docblock for
 * the contract). A per-target failure is isolated into an error entry — the
 * rest of the fleet still scores. `now` is pinned across the whole pass for
 * a deterministic, reproducible report.
 */
export async function runFleet(fleet: Fleet, deps: FleetRunDeps = {}): Promise<FleetReport> {
	const audit = deps.audit ?? runWorkspaceAudit;
	const drift = deps.drift ?? driftRepo;
	const pathExists = deps.pathExists ?? realPathExists;
	const now = deps.now ?? new Date();

	const entries: FleetEntry[] = [];
	for (const target of fleet.targets) {
		entries.push(await runTarget(target, fleet.defaults, audit, drift, pathExists, deps, now));
	}

	const ok = entries.filter((e) => e.ok).length;
	const policyFailed = entries.filter((e) => e.ok && e.policy.failed).length;
	return {
		auditedAt: now.toISOString(),
		entries,
		summary: { ok, error: entries.length - ok, policyFailed },
	};
}
