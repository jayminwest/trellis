/**
 * Fleet service (SPEC §13.1, trellis-8366) — the fleet entrypoint the CLI and
 * SDK both fold. {@link runFleet} is the pure orchestration;
 * {@link runFleetTargets} adds the wiring that was inline in the CLI: load +
 * validate the `targets.yaml` and run every target through the deterministic
 * core (the same {@link runWorkspaceAudit} the single-repo surfaces fold).
 * The SDK's `fleet()` is a direct call to it.
 *
 * Stateless by default (SPEC §8, §10): no database is opened unless `history`
 * is opted into — then each target's run appends to the central audit history
 * (`db` overrides its location) and the entry carries the index move against
 * the repo's previous compatible stored run.
 *
 * Retired readiness knobs (`rubric`, `rubricVersion`, `failOn`, `minLevel`,
 * `store`) and investigation knobs (`noCache`, `piBin`, …) on the options bag
 * are rejected with actionable migration errors, never silently ignored.
 */
import { AuditRunError } from "../audit/index.ts";
import { LegacyConfigError, legacyConfigMessage, retiredReadinessMessage } from "../legacy.ts";
import { type FleetReport, runFleet } from "./orchestrate.ts";
import { loadFleet, TARGETS_FILE } from "./targets.ts";

/** Options for {@link runFleetTargets} — the user-facing fleet surface (mirrors the CLI flags). */
export interface FleetRunOptions {
	/** Opt-in persistence (SPEC §10): record each target's run and resolve stored baselines. Default false. */
	history?: boolean;
	/** SQLite history path (meaningful only with `history`); defaults to `$TRELLIS_DB` or `~/.trellis/trellis.db`. */
	db?: string;
	/** Wall-clock pinned across the whole pass; defaults to now. */
	now?: Date;
}

/** Option-bag keys retired with the readiness product (SPEC §14 stage 9), rejected actionably. */
const RETIRED_READINESS_KEYS = ["rubric", "rubricVersion", "failOn", "minLevel", "store"] as const;

/**
 * Reject retired knobs on the public options bag. TypeScript callers get a
 * compile error from the narrowed option type; this guard gives untyped
 * callers the same actionable failure instead of a silent ignore — the
 * investigation-era keys via {@link legacyConfigMessage}, the readiness-era
 * keys via {@link retiredReadinessMessage}.
 */
function rejectRetiredOptions(opts: object): void {
	for (const key of ["noCache", "piBin", "investigation", "provider", "model"]) {
		if (key in opts) throw new LegacyConfigError(legacyConfigMessage(`option '${key}'`));
	}
	for (const key of RETIRED_READINESS_KEYS) {
		if (key in opts) throw new AuditRunError(retiredReadinessMessage(`option '${key}'`));
	}
}

/**
 * Load the fleet at `targetsPath` and audit every target through the
 * deterministic core, returning the aggregate {@link FleetReport}. A
 * per-target failure is isolated into an error entry without aborting the
 * fleet (SPEC §11); a malformed `targets.yaml` (including retired
 * readiness/investigation keys) throws a `TargetsError`.
 */
export async function runFleetTargets(
	targetsPath: string = TARGETS_FILE,
	opts: FleetRunOptions = {},
): Promise<FleetReport> {
	rejectRetiredOptions(opts);
	if (opts.db !== undefined && opts.history !== true) {
		throw new AuditRunError(
			"db is meaningful only with history: fleet runs are stateless by default (SPEC §10) — " +
				"pass --history (CLI) or history: true (SDK) to record the runs",
		);
	}
	const fleet = loadFleet(targetsPath);
	return runFleet(fleet, {
		...(opts.now ? { now: opts.now } : {}),
		...(opts.history === true ? { history: true } : {}),
		...(opts.history === true && opts.db !== undefined ? { db: opts.db } : {}),
	});
}
