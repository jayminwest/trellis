/**
 * Fleet service (SPEC §13.1) — the store-lifecycle-wrapped fleet entrypoint the
 * CLI and SDK both fold. {@link runFleet} is the pure orchestration;
 * {@link runFleetTargets} adds the wiring that was inline in the CLI: load +
 * validate the `targets.yaml`, load the rubric once, open the central store, run
 * every target, and close the store. The SDK's `fleet()` is a direct call to it.
 */
import { loadRubric, type Rubric } from "../rubric/index.ts";
import { openStore } from "../store/index.ts";
import { type FleetReport, runFleet } from "./orchestrate.ts";
import { loadFleet, TARGETS_FILE } from "./targets.ts";

/** Options for {@link runFleetTargets} — the user-facing fleet surface (mirrors the CLI flags). */
export interface FleetRunOptions {
	/** SQLite history path; defaults to `$TRELLIS_DB` or `~/.trellis/trellis.db`. */
	db?: string;
	/** Force re-investigation for every target (`--no-cache`). */
	noCache?: boolean;
	/** `pi` binary override passed through to the investigation provider. */
	piBin?: string;
	/** Wall-clock pinned across the whole pass; defaults to now. */
	now?: Date;
	/** Preloaded rubric, shared across targets; defaults to the bundled rubric. */
	rubric?: Rubric;
	/** Informational rubric-version pin echoed onto each report (SPEC §12). */
	rubricVersion?: string;
}

/**
 * Load the fleet at `targetsPath`, audit every target (persisting each run to the
 * central history), and return the aggregate {@link FleetReport}. The rubric is
 * loaded once and shared across targets; a per-target failure is isolated into an
 * error entry without aborting the fleet (SPEC §6.5).
 */
export async function runFleetTargets(
	targetsPath: string = TARGETS_FILE,
	opts: FleetRunOptions = {},
): Promise<FleetReport> {
	const fleet = loadFleet(targetsPath);
	const rubric = opts.rubric ?? loadRubric();
	const store = openStore(opts.db);
	try {
		return await runFleet(fleet, {
			store,
			rubric,
			...(opts.noCache ? { noCache: true } : {}),
			...(opts.piBin ? { piBin: opts.piBin } : {}),
			...(opts.now ? { now: opts.now } : {}),
			...(opts.rubricVersion ? { rubricVersion: opts.rubricVersion } : {}),
		});
	} finally {
		store.close();
	}
}
