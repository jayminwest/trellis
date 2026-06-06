/**
 * App-discovery contract (SPEC §8.2). An {@link App} is one
 * independently-deployable directory — the unit app-scope criteria are measured
 * against. `path` is repo-relative (`.` for the repo root); `languages` drives
 * adapter resolution in the detector registry (SPEC §8.3); `description` feeds
 * the report's §6.3 `apps` map.
 *
 * `Language` is re-used from the detector layer so discovery and detectors share
 * one vocabulary — the languages discovery tags an app with are exactly the ones
 * `DetectorRegistry.resolve` dispatches on.
 */
import type { Language } from "../detectors/types.ts";

export type { Language } from "../detectors/types.ts";

/** One independently-deployable directory (SPEC §8.2). */
export interface App {
	/** Repo-relative path; `.` for the repo root. */
	path: string;
	/** Detected (or hinted) languages, sorted and de-duplicated. */
	languages: Language[];
	/** Human label for the §6.3 `apps` map (package name/description, else dir basename). */
	description: string;
}

/** Options for {@link discoverApps}. */
export interface DiscoverOptions {
	/**
	 * Optional `languages` hint from `targets.yaml` (SPEC §6.5). When present it
	 * **overrides** auto-detection for every discovered app — the operator has
	 * declared the fleet entry's languages and we honor that verbatim.
	 */
	languages?: readonly Language[];
	/** Max directory depth to descend below the repo root (guard). Default `8`. */
	maxDepth?: number;
}
