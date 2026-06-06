/**
 * The audit pipeline (SPEC §14 milestone 3) — the core entrypoint the CLI and
 * SDK both fold. {@link auditRepo} wires the surface-agnostic stages end to end:
 * rubric → app discovery → criterion→detector resolution → per-app/-repo detector
 * runs → agent-criteria investigation (cache-or-run, SPEC §7.3) → §3.4 scoring →
 * the §6.3 {@link Report}.
 *
 * Two N/A disciplines coexist (SPEC §3.2): a deterministic criterion with no
 * binding (or no adapter for the app's languages) flows through the registry's
 * `no-detector` stub; an **agent**-discovery criterion is graded from its area's
 * investigated facts, degrading to `no-detector` when the area is unavailable (Pi
 * missing/incompatible, or a per-area failure) or when no investigation is wired.
 * Both keep the score from lying about what trellis can actually measure.
 *
 * The pipeline is deterministic given (checkout, rubric, detector set, cached
 * findings): the only wall-clock input is `scoredAt`, injectable via `opts.now`.
 * Agent findings are frozen per commit, so a same-commit re-run is byte-identical.
 */
import { basename, resolve } from "node:path";
import type { DetectorResult, Language } from "../detectors/index.ts";
import { createDetectionContext, type DetectorRegistry, REGISTRY } from "../detectors/index.ts";
import { applyOsecoOverlay } from "../detectors/oseco/overlay.ts";
import type { App } from "../discovery/index.ts";
import { discoverApps, toAppMap } from "../discovery/index.ts";
import {
	type AreaId,
	type AreaResolution,
	type Grade,
	gradeCriterion,
	type InvestigationDeps,
	runInvestigation,
} from "../investigation/index.ts";
import { type CriterionRecord, loadRubric, RUBRIC_VERSION, type Rubric } from "../rubric/index.ts";
import {
	aggregateAppScope,
	aggregateRepoScope,
	MAX_RATIONALE,
	type Outcome,
	type ScorecardEntry,
	scoreRun,
} from "../scoring/index.ts";
import { type DriftOptions, type DriftReport, driftRepo } from "../standards/index.ts";
import { changesSinceLastRun } from "./changes.ts";
import type { Report } from "./types.ts";

/** Rationale stamped on agent criteria when no investigation is wired into the audit. */
export const AGENT_NOT_WIRED = "investigation layer not wired for this run";

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
	 * Cache + provider wiring for the agent-criteria investigation (SPEC §7.3).
	 * Absent → agent criteria resolve to `no-detector` ({@link AGENT_NOT_WIRED})
	 * exactly as a det-only run; present → each referenced area is investigated
	 * (cache-or-run) once and its facts grade every criterion bound to it.
	 */
	investigation?: InvestigationDeps;
	/**
	 * Canonical-config drift wiring (SPEC §10). Present → the audit compares the
	 * checkout against the bundled canonical set and folds the result into
	 * `report.drift`; absent → no `drift` key is emitted (the §6.3 default).
	 */
	canonical?: DriftOptions;
	/**
	 * Repo id for the report + investigation cache + drift (SPEC §6.4/§6.5). The
	 * fleet supplies the `targets.yaml` id so central state keys on a stable name;
	 * defaults to the audited path's basename.
	 */
	repoId?: string;
	/**
	 * Criterion ids forced not-applicable with {@link SKIPPED_VIA_TARGETS} (SPEC
	 * §6.5 `targets.yaml` `skip`); skips their detector/area entirely.
	 */
	skip?: readonly string[];
	/**
	 * os-eco-native detector toggle (SPEC §6.5/§8.4), surfaced on every detection
	 * context. Default on; `false` opts a repo out of seeds/mulch/canopy evidence.
	 */
	osecoDetectors?: boolean;
	/** The repo's most recent prior run (SPEC §11): present → fold a `changesSinceLastRun` delta; absent → first run. */
	previousRun?: Report | null;
}

/** Rationale stamped on a criterion forced not-applicable by `targets.yaml` `skip` (SPEC §6.5). */
export const SKIPPED_VIA_TARGETS = "skipped via targets.yaml";

/** Map a {@link DetectorResult} onto the aggregator's {@link Outcome} vocabulary. */
function outcomeOf(result: DetectorResult): Outcome {
	if (result.numerator === 1) return "pass";
	if (result.numerator === 0) return "fail";
	return result.naKind === "not-applicable" ? "not-applicable" : "no-detector";
}

/** Clip a rationale to the §6.2 ≤500-char cap (mirrors the scoring-layer helpers). */
function clip(rationale: string): string {
	if (rationale.length <= MAX_RATIONALE) return rationale;
	return `${rationale.slice(0, MAX_RATIONALE - 1)}…`;
}

/** A `no-detector` agent entry with the given rationale (denominator honors §6.2: app → N, repo → 1). */
function agentNoDetector(
	scope: "repo" | "app",
	appCount: number,
	rationale: string,
): ScorecardEntry {
	return {
		numerator: null,
		denominator: scope === "app" ? appCount : 1,
		rationale: clip(rationale),
		naKind: "no-detector",
	};
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

/** Map a per-unit {@link Grade} to a §6.2 repo-scope entry (denominator `1`); the grade *is* the entry. */
function gradeToRepoEntry(grade: Grade): ScorecardEntry {
	return grade.naKind === undefined
		? { numerator: grade.numerator, denominator: 1, rationale: grade.rationale }
		: {
				numerator: grade.numerator,
				denominator: 1,
				naKind: grade.naKind,
				rationale: grade.rationale,
			};
}

/**
 * Project a per-unit {@link Grade} onto an app-scope §6.2 entry. The area is
 * investigated once per repo (SPEC §7.1), so its single verdict applies
 * uniformly to all `N` apps: pass → `N/N`, fail → `0/N`, N/A → `null/N`. The
 * grader's fact-rich rationale is preserved rather than re-synthesized.
 */
function gradeToAppEntry(grade: Grade, appCount: number): ScorecardEntry {
	if (grade.numerator === null) {
		return {
			numerator: null,
			denominator: appCount,
			naKind: grade.naKind ?? "no-detector",
			rationale: grade.rationale,
		};
	}
	return {
		numerator: grade.numerator === 1 ? appCount : 0,
		denominator: appCount,
		rationale: grade.rationale,
	};
}

/**
 * Resolve one agent-discovery criterion into its scorecard entry from the
 * already-resolved area findings. No investigation wired → {@link
 * AGENT_NOT_WIRED}; the area failed/was unavailable → `no-detector` naming the
 * area + reason; success → the deterministic grader's verdict, projected onto
 * the criterion's scope.
 */
function agentEntry(
	criterion: CriterionRecord,
	appCount: number,
	resolutions: Map<AreaId, AreaResolution>,
): ScorecardEntry {
	if (resolutions.size === 0 && criterion.investigation === null) {
		// Unreachable (schema guarantees agent ⇒ area), but keeps the type total.
		return agentNoDetector(criterion.scope, appCount, AGENT_NOT_WIRED);
	}
	const area = criterion.investigation as AreaId;
	const resolution = resolutions.get(area);
	if (resolution === undefined) {
		return agentNoDetector(criterion.scope, appCount, AGENT_NOT_WIRED);
	}
	if (!resolution.ok) {
		return agentNoDetector(criterion.scope, appCount, `${area} area: ${resolution.reason}`);
	}
	const grade = gradeCriterion(criterion.id, resolution.findings);
	return criterion.scope === "app" ? gradeToAppEntry(grade, appCount) : gradeToRepoEntry(grade);
}

/** The agent areas referenced by any agent criterion in `rubric`, de-duplicated. */
function neededAreas(rubric: Rubric): AreaId[] {
	const set = new Set<AreaId>();
	for (const c of rubric.criteria) {
		if (c.discoveryVia === "agent" && c.investigation !== null) set.add(c.investigation as AreaId);
	}
	return [...set];
}

/** One detection context paired with the app it views (repo-scope uses `app.path === "."`). */
interface AppContext {
	app: App;
	ctx: ReturnType<typeof createDetectionContext>;
}

/**
 * Score one deterministic criterion via its bound detector(s): a repo-scope
 * criterion runs once at the root; an app-scope criterion runs per app and the
 * results roll up (SPEC §3.1). The registry resolution is total, so an unbound
 * criterion (or one with no adapter for the app's languages) lands as
 * `no-detector` without throwing.
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
 * criterion is forced not-applicable (and the overlay never overrides that
 * intentional exclusion); an agent criterion is graded from its area's findings;
 * everything else runs its deterministic detector(s). os-eco-native evidence
 * (SPEC §8.4) is then folded over every non-skipped verdict (pass if either
 * passes), gated by the repo context's `osecoDetectors` toggle.
 */
async function scoreAllCriteria(
	rubric: Rubric,
	skip: ReadonlySet<string>,
	resolutions: Map<AreaId, AreaResolution>,
	registry: DetectorRegistry,
	repoCtx: ReturnType<typeof createDetectionContext>,
	appCtxs: readonly AppContext[],
	appCount: number,
): Promise<Record<string, ScorecardEntry>> {
	const criteria: Record<string, ScorecardEntry> = {};
	for (const criterion of rubric.criteria) {
		if (skip.has(criterion.id)) {
			criteria[criterion.id] = skippedEntry(criterion.scope, appCount);
			continue;
		}
		const base =
			criterion.discoveryVia === "agent"
				? agentEntry(criterion, appCount, resolutions)
				: await deterministicEntry(criterion, registry, repoCtx, appCtxs);
		criteria[criterion.id] = await applyOsecoOverlay(criterion, base, repoCtx, appCount);
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
 * repo. A dirty worktree gets a `-dirty` suffix so a cache key never claims a
 * commit it does not match (SPEC §7.3): two audits at the same sha with
 * uncommitted edits stay distinct from the clean commit.
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
 * Every deterministic criterion runs its bound detector (per app for app-scope,
 * once at the root for repo-scope). Agent-discovery criteria are graded from the
 * investigation layer when `opts.investigation` is wired — each referenced area
 * is resolved once (cache-or-run, SPEC §7.3) and its facts feed the
 * deterministic grader — and resolve to `no-detector` ({@link AGENT_NOT_WIRED})
 * otherwise. `criteria` is built in rubric order so the JSON serialization is
 * byte-stable; a same-commit re-run reuses cached findings → byte-identical.
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

	const apps = await discoverApps(root, {
		...(opts.languages ? { languages: opts.languages } : {}),
		...(opts.maxDepth === undefined ? {} : { maxDepth: opts.maxDepth }),
	});

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

	// Investigate the referenced areas once each (cache-or-run); without wiring
	// the map is empty and agent criteria fall through to AGENT_NOT_WIRED.
	const resolutions = opts.investigation
		? await runInvestigation(
				neededAreas(rubric),
				{ repoPath: root, repo, commitSha: commit, createdAt: scoredAt },
				opts.investigation,
			)
		: new Map<AreaId, AreaResolution>();

	const criteria = await scoreAllCriteria(
		rubric,
		skip,
		resolutions,
		registry,
		repoCtx,
		appCtxs,
		apps.length,
	);

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
