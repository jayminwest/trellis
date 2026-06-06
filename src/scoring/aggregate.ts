/**
 * Repo/app aggregation (SPEC §3.1, §3.4) — folds raw per-scope outcomes into a
 * single §6.2 {@link ScorecardEntry}.
 *
 * - **repo-scope** — one outcome; denominator always `1`.
 * - **app-scope** — `N` per-app outcomes roll into `numerator = passing apps`,
 *   `denominator = N`. If *no* app passes or fails (every app is N/A), the whole
 *   criterion goes N/A: `no-detector` if any app couldn't be measured, else
 *   `not-applicable`.
 *
 * The per-app/-repo {@link Outcome} is a minimal local contract; the full
 * `DetectorResult` shape (SPEC §8.1) lands with trellis-5963 and will supply
 * these.
 */
import { MAX_RATIONALE, type NaKind, type ScorecardEntry } from "./entry.ts";

/** A single scope outcome: a real pass/fail, or one of the two N/A flavours (SPEC §3.2). */
export const OUTCOMES = ["pass", "fail", "not-applicable", "no-detector"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** One repo-scope outcome. */
export interface RepoResult {
	outcome: Outcome;
	rationale: string;
}

/** One app's outcome for an app-scope criterion. */
export interface AppResult {
	/** App id / path (for the synthesized rationale). */
	app: string;
	outcome: Outcome;
	rationale?: string;
}

/** Clip a rationale to the §6.2 ≤500-char cap. */
function clip(rationale: string): string {
	return rationale.length > MAX_RATIONALE ? rationale.slice(0, MAX_RATIONALE) : rationale;
}

/**
 * Aggregate a repo-scope outcome into a §6.2 entry. Denominator is always `1`
 * (SPEC §3.1): `pass → 1/1`, `fail → 0/1`, N/A → `null/1` with the outcome's
 * `naKind`.
 */
export function aggregateRepoScope(result: RepoResult): ScorecardEntry {
	const rationale = clip(result.rationale);
	if (result.outcome === "pass") return { numerator: 1, denominator: 1, rationale };
	if (result.outcome === "fail") return { numerator: 0, denominator: 1, rationale };
	return { numerator: null, denominator: 1, rationale, naKind: result.outcome };
}

/**
 * Aggregate `N` per-app outcomes into a §6.2 entry. `denominator = N`,
 * `numerator = passing apps`. When no app passes or fails the criterion is N/A
 * for the repo — `no-detector` if any app couldn't be measured, else
 * `not-applicable`. Requires ≥1 app (app discovery guarantees a root app when
 * none are found, SPEC §8.2).
 */
export function aggregateAppScope(results: readonly AppResult[]): ScorecardEntry {
	if (results.length === 0) {
		throw new Error("aggregateAppScope requires at least one app (SPEC §8.2)");
	}
	const total = results.length;
	const passing = results.filter((r) => r.outcome === "pass").length;
	const failing = results.filter((r) => r.outcome === "fail").length;

	if (passing + failing === 0) {
		const naKind: NaKind = results.some((r) => r.outcome === "no-detector")
			? "no-detector"
			: "not-applicable";
		return {
			numerator: null,
			denominator: total,
			rationale: clip(`${total}/${total} apps N/A (${naKind})`),
			naKind,
		};
	}

	const detail = results.map((r) => `${r.app}: ${r.outcome}`).join(", ");
	return {
		numerator: passing,
		denominator: total,
		rationale: clip(`${passing}/${total} apps pass — ${detail}`),
	};
}
