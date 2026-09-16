/**
 * The audit pipeline (SPEC §14 milestone 3) — the core entrypoint the CLI and
 * SDK both fold. {@link auditRepo} wires the surface-agnostic stages end to end:
 * rubric → app discovery → criterion→detector resolution → per-app/-repo detector
 * runs → §3.4 scoring → the §6.3 {@link Report}.
 *
 * Transitional (SPEC §14 stage 2): the agent investigation pass is disconnected
 * — there is no route to Pi or any model from this pipeline, and the transitional
 * catalog carries only deterministic criteria. A criterion with no binding (or
 * no adapter for the app's languages) flows through the registry's `no-detector`
 * stub (SPEC §3.2), keeping the score honest about what trellis can measure.
 *
 * The pipeline is deterministic given (checkout, rubric, detector set): the only
 * wall-clock input is `scoredAt`, injectable via `opts.now`.
 */
import { basename, resolve } from "node:path";
import type { DetectorResult, Language } from "../detectors/index.ts";
import { createDetectionContext, type DetectorRegistry, REGISTRY } from "../detectors/index.ts";
import type { App } from "../discovery/index.ts";
import { discoverApps, toAppMap } from "../discovery/index.ts";
import { type CriterionRecord, loadRubric, RUBRIC_VERSION, type Rubric } from "../rubric/index.ts";
import {
	aggregateAppScope,
	aggregateRepoScope,
	type Outcome,
	type ScorecardEntry,
	scoreRun,
} from "../scoring/index.ts";
import { type DriftOptions, type DriftReport, driftRepo } from "../standards/index.ts";
import { changesSinceLastRun } from "./changes.ts";
import type { AuditProgress } from "./progress.ts";
import type { Report } from "./types.ts";

/** Options for {@link auditRepo}. All optional — defaults give a real CLI audit. */
export interface AuditOptions {
	/**
	 * Wall-clock time for `scoredAt`. Injectable so determinism tests can pin it;
	 * defaults to now. The only non-repo-derived input to the report.
	 */
	now?: Date;
	/** Informational rubric-version pin echoed onto the report (SPEC §12). */
	rubricVersion?: string;
	/** Preloaded rubric — pass to avoid a second load when the caller already has one. */
	rubric?: Rubric;
	/** Alternate rubric directory (test hook); ignored when `rubric` is given. */
	rubricDir?: string;
	/** `targets.yaml` language hint — overrides auto-detection for every app (SPEC §6.5). */
	languages?: readonly Language[];
	/** Detector registry (test hook); defaults to the authored {@link REGISTRY}. */
	registry?: DetectorRegistry;
	/** Max directory depth for app discovery (SPEC §8.2 guard). */
	maxDepth?: number;
	/** Per-detector subprocess timeout (ms). */
	timeoutMs?: number;
	/**
	 * Canonical-config drift wiring (SPEC §10). Present → the audit compares the
	 * checkout against the bundled canonical set and folds the result into
	 * `report.drift`; absent → no `drift` key is emitted (the §6.3 default).
	 */
	canonical?: DriftOptions;
	/**
	 * Repo id for the report + drift (SPEC §6.4/§6.5). The fleet supplies the
	 * `targets.yaml` id so central state keys on a stable name; defaults to the
	 * audited path's basename.
	 */
	repoId?: string;
	/**
	 * Criterion ids forced not-applicable with {@link SKIPPED_VIA_TARGETS} (SPEC
	 * §6.5 `targets.yaml` `skip`); skips their detector entirely.
	 */
	skip?: readonly string[];
	/**
	 * os-eco-native detector toggle (SPEC §6.5/§8.4), surfaced on every detection
	 * context. Default on; `false` opts a repo out of seeds/mulch/canopy evidence.
	 */
	osecoDetectors?: boolean;
	/** The repo's most recent prior run (SPEC §11): present → fold a `changesSinceLastRun` delta; absent → first run. */
	previousRun?: Report | null;
	/**
	 * Optional progress sink. Core emits phase transitions and app/detector
	 * counts; the CLI owns rendering them to stderr. Absent → a silent,
	 * byte-identical run.
	 */
	onProgress?: AuditProgress;
}

/** Rationale stamped on a criterion forced not-applicable by `targets.yaml` `skip` (SPEC §6.5). */
export const SKIPPED_VIA_TARGETS = "skipped via targets.yaml";

/** Map a {@link DetectorResult} onto the aggregator's {@link Outcome} vocabulary. */
function outcomeOf(result: DetectorResult): Outcome {
	if (result.numerator === 1) return "pass";
	if (result.numerator === 0) return "fail";
	return result.naKind === "not-applicable" ? "not-applicable" : "no-detector";
}

/**
 * A `not-applicable` entry for a criterion the fleet forced to skip (SPEC §6.5).
 * Denominator honors §6.2 (app → N, repo → 1); the kind is `not-applicable` (an
 * intentional exclusion, not a coverage gap) with the {@link SKIPPED_VIA_TARGETS}
 * rationale.
 */
function skippedEntry(scope: "repo" | "app", appCount: number): ScorecardEntry {
	return {
		numerator: null,
		denominator: scope === "app" ? appCount : 1,
		rationale: SKIPPED_VIA_TARGETS,
		naKind: "not-applicable",
	};
}

/** One detection context paired with the app it views (repo-scope uses `app.path === "."`). */
interface AppContext {
	app: App;
	ctx: ReturnType<typeof createDetectionContext>;
}

/**
 * Score one criterion via its bound detector(s): a repo-scope criterion runs
 * once at the root; an app-scope criterion runs per app and the results roll up
 * (SPEC §3.1). The registry resolution is total, so an unbound criterion (or one
 * with no adapter for the app's languages) lands as `no-detector` without
 * throwing.
 */
async function deterministicEntry(
	criterion: CriterionRecord,
	registry: DetectorRegistry,
	repoCtx: ReturnType<typeof createDetectionContext>,
	appCtxs: readonly AppContext[],
): Promise<ScorecardEntry> {
	if (criterion.scope === "repo") {
		const result = await registry.resolve(criterion.id, repoCtx.app.languages)(repoCtx);
		return aggregateRepoScope({ outcome: outcomeOf(result), rationale: result.rationale });
	}
	const perApp = await Promise.all(
		appCtxs.map(async ({ app, ctx }) => {
			const result = await registry.resolve(criterion.id, app.languages)(ctx);
			return { app: app.path, outcome: outcomeOf(result), rationale: result.rationale };
		}),
	);
	return aggregateAppScope(perApp);
}

/**
 * Score every rubric criterion into its §6.2 entry, in rubric order. A `skip`ped
 * criterion is forced not-applicable; everything else runs its deterministic
 * detector(s).
 */
async function scoreAllCriteria(
	rubric: Rubric,
	skip: ReadonlySet<string>,
	registry: DetectorRegistry,
	repoCtx: ReturnType<typeof createDetectionContext>,
	appCtxs: readonly AppContext[],
	appCount: number,
	onProgress?: AuditProgress,
): Promise<Record<string, ScorecardEntry>> {
	const criteria: Record<string, ScorecardEntry> = {};
	const total = rubric.criteria.length;
	let index = 0;
	for (const criterion of rubric.criteria) {
		onProgress?.({ type: "detector", id: criterion.id, index: index++, total });
		criteria[criterion.id] = skip.has(criterion.id)
			? skippedEntry(criterion.scope, appCount)
			: await deterministicEntry(criterion, registry, repoCtx, appCtxs);
	}
	return criteria;
}

/**
 * Fold canonical-config drift into the run (SPEC §10) when a canonical version is
 * wired, else `undefined` (the §6.3 default omits the key). The audit's `repoId`
 * seeds the drift report's id; an explicit `canonical.repoId` (the fleet sets one)
 * still wins.
 */
function foldDrift(root: string, opts: AuditOptions): DriftReport | undefined {
	if (!opts.canonical) return undefined;
	return driftRepo(root, {
		...(opts.repoId === undefined ? {} : { repoId: opts.repoId }),
		...opts.canonical,
	});
}

/** Union of every app's languages, sorted — the language set repo-scope detectors resolve against. */
function repoLanguages(apps: readonly App[]): Language[] {
	const set = new Set<Language>();
	for (const app of apps) for (const lang of app.languages) set.add(lang);
	return [...set].sort();
}

/**
 * Best-effort `HEAD` sha via the read-only context; `"unknown"` when not a git
 * repo. A dirty worktree gets a `-dirty` suffix so the report never claims a
 * clean commit it does not match.
 */
async function resolveCommit(ctx: ReturnType<typeof createDetectionContext>): Promise<string> {
	const res = await ctx.run(["git", "rev-parse", "HEAD"]);
	const sha = res.stdout.trim();
	if (res.exitCode !== 0 || sha.length === 0) return "unknown";
	const status = await ctx.run(["git", "status", "--porcelain"]);
	const dirty = status.exitCode === 0 && status.stdout.trim().length > 0;
	return dirty ? `${sha}-dirty` : sha;
}

/**
 * Run an audit of the repo at `repoPath` and assemble its §6.3 {@link Report}.
 * Every criterion runs its bound detector (per app for app-scope, once at the
 * root for repo-scope). `criteria` is built in rubric order so the JSON
 * serialization is byte-stable; two runs of the same checkout with the same
 * `now` are byte-identical.
 */
export async function auditRepo(repoPath: string, opts: AuditOptions = {}): Promise<Report> {
	const root = resolve(repoPath);
	const rubric = opts.rubric ?? loadRubric(opts.rubricDir);
	const registry = opts.registry ?? REGISTRY;
	const ctxOpts = {
		...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
		...(opts.osecoDetectors === undefined ? {} : { osecoDetectors: opts.osecoDetectors }),
	};
	const repo = opts.repoId ?? basename(root);
	const skip = new Set(opts.skip ?? []);
	const scoredAt = (opts.now ?? new Date()).toISOString();
	const onProgress = opts.onProgress;

	onProgress?.({ type: "phase", phase: "discovery" });
	const apps = await discoverApps(root, {
		...(opts.languages ? { languages: opts.languages } : {}),
		...(opts.maxDepth === undefined ? {} : { maxDepth: opts.maxDepth }),
	});
	onProgress?.({ type: "apps-discovered", count: apps.length });

	const repoCtx = createDetectionContext(
		root,
		{ path: ".", languages: repoLanguages(apps) },
		ctxOpts,
	);
	const appCtxs = apps.map((app) => ({
		app,
		ctx: createDetectionContext(root, { path: app.path, languages: app.languages }, ctxOpts),
	}));

	const commit = await resolveCommit(repoCtx);

	onProgress?.({ type: "phase", phase: "detectors" });
	const criteria = await scoreAllCriteria(
		rubric,
		skip,
		registry,
		repoCtx,
		appCtxs,
		apps.length,
		onProgress,
	);

	onProgress?.({ type: "phase", phase: "scoring" });
	const entries = new Map(Object.entries(criteria));
	const score = scoreRun(
		rubric.criteria.map((c) => c.id),
		entries,
	);

	const drift = foldDrift(root, opts);
	const report: Report = {
		repo,
		rubricVersion: opts.rubricVersion ?? RUBRIC_VERSION,
		scoredAt,
		commit,
		level: score.level,
		passRate: score.passRate,
		coverage: score.coverage,
		apps: toAppMap(apps),
		criteria,
		...(drift ? { drift } : {}),
	};
	// Fold the §11 delta last (after drift) so key order stays byte-stable; a first run omits the key.
	if (!opts.previousRun) return report;
	return { ...report, changesSinceLastRun: changesSinceLastRun(report, opts.previousRun) };
}
