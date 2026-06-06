/**
 * The det-only audit pipeline (SPEC §14 milestone 3) — the core entrypoint the
 * CLI and SDK both fold. {@link auditRepo} wires the surface-agnostic stages end
 * to end: rubric → app discovery → criterion→detector resolution → per-app/-repo
 * detector runs → §3.4 scoring → the §6.3 {@link Report}.
 *
 * Two N/A disciplines coexist (SPEC §3.2): a deterministic criterion with no
 * binding (or no adapter for the app's languages) flows through the registry's
 * `no-detector` stub; an **agent**-discovery criterion never reaches the registry
 * — the investigation layer is not wired yet (trellis-4222), so it resolves to a
 * `no-detector` entry that honestly drags coverage down. Both keep the score from
 * lying about what trellis can actually measure today.
 *
 * The pipeline is deterministic given (checkout, rubric, detector set): the only
 * wall-clock input is `scoredAt`, injectable via `opts.now` so two runs of the
 * same checkout serialize byte-identically.
 */
import { basename, resolve } from "node:path";
import type { DetectorResult, Language } from "../detectors/index.ts";
import { createDetectionContext, type DetectorRegistry, REGISTRY } from "../detectors/index.ts";
import type { App } from "../discovery/index.ts";
import { discoverApps, toAppMap } from "../discovery/index.ts";
import { loadRubric, RUBRIC_VERSION, type Rubric } from "../rubric/index.ts";
import {
	aggregateAppScope,
	aggregateRepoScope,
	type Outcome,
	type ScorecardEntry,
	scoreRun,
} from "../scoring/index.ts";
import type { Report } from "./types.ts";

/** Rationale stamped on agent-discovery criteria until the investigation layer lands (trellis-4222). */
export const AGENT_NOT_WIRED = "investigation layer not yet wired";

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
}

/** Map a {@link DetectorResult} onto the aggregator's {@link Outcome} vocabulary. */
function outcomeOf(result: DetectorResult): Outcome {
	if (result.numerator === 1) return "pass";
	if (result.numerator === 0) return "fail";
	return result.naKind === "not-applicable" ? "not-applicable" : "no-detector";
}

/** The no-detector entry for an agent criterion (denominator honors §6.2: app → N, repo → 1). */
function agentEntry(scope: "repo" | "app", appCount: number): ScorecardEntry {
	return {
		numerator: null,
		denominator: scope === "app" ? appCount : 1,
		rationale: AGENT_NOT_WIRED,
		naKind: "no-detector",
	};
}

/** Union of every app's languages, sorted — the language set repo-scope detectors resolve against. */
function repoLanguages(apps: readonly App[]): Language[] {
	const set = new Set<Language>();
	for (const app of apps) for (const lang of app.languages) set.add(lang);
	return [...set].sort();
}

/** Best-effort `HEAD` sha via the read-only context; `"unknown"` when not a git repo. */
async function resolveCommit(ctx: ReturnType<typeof createDetectionContext>): Promise<string> {
	const res = await ctx.run(["git", "rev-parse", "HEAD"]);
	const sha = res.stdout.trim();
	return res.exitCode === 0 && sha.length > 0 ? sha : "unknown";
}

/**
 * Run a det-only audit of the repo at `repoPath` and assemble its §6.3
 * {@link Report}. Agent-discovery criteria resolve to `no-detector`
 * ({@link AGENT_NOT_WIRED}); every deterministic criterion runs its bound
 * detector (per app for app-scope, once at the root for repo-scope) and the
 * results aggregate into the scorecard. `criteria` is built in rubric order so
 * the JSON serialization is byte-stable.
 */
export async function auditRepo(repoPath: string, opts: AuditOptions = {}): Promise<Report> {
	const root = resolve(repoPath);
	const rubric = opts.rubric ?? loadRubric(opts.rubricDir);
	const registry = opts.registry ?? REGISTRY;
	const ctxOpts = opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs };

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

	const criteria: Record<string, ScorecardEntry> = {};
	for (const criterion of rubric.criteria) {
		if (criterion.discoveryVia === "agent") {
			criteria[criterion.id] = agentEntry(criterion.scope, apps.length);
			continue;
		}
		if (criterion.scope === "repo") {
			const detector = registry.resolve(criterion.id, repoCtx.app.languages);
			const result = await detector(repoCtx);
			criteria[criterion.id] = aggregateRepoScope({
				outcome: outcomeOf(result),
				rationale: result.rationale,
			});
			continue;
		}
		const perApp = await Promise.all(
			appCtxs.map(async ({ app, ctx }) => {
				const detector = registry.resolve(criterion.id, app.languages);
				const result = await detector(ctx);
				return { app: app.path, outcome: outcomeOf(result), rationale: result.rationale };
			}),
		);
		criteria[criterion.id] = aggregateAppScope(perApp);
	}

	const entries = new Map(Object.entries(criteria));
	const score = scoreRun(
		rubric.criteria.map((c) => c.id),
		entries,
	);

	return {
		repo: basename(root),
		rubricVersion: opts.rubricVersion ?? RUBRIC_VERSION,
		scoredAt: (opts.now ?? new Date()).toISOString(),
		commit,
		level: score.level,
		passRate: score.passRate,
		coverage: score.coverage,
		apps: toAppMap(apps),
		criteria,
	};
}
