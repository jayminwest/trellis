/** Load targets and audit each workspace through the shared core, with opt-in history. */
import { AuditRunError } from "../audit/index.ts";
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

/**
 * Load the fleet at `targetsPath` and audit every target through the
 * deterministic core, returning the aggregate {@link FleetReport}. A
 * per-target failure is isolated into an error entry without aborting the
 * fleet (SPEC §11); a malformed `targets.yaml` throws a `TargetsError`.
 */
export async function runFleetTargets(
	targetsPath: string = TARGETS_FILE,
	opts: FleetRunOptions = {},
): Promise<FleetReport> {
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
