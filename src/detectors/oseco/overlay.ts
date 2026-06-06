/**
 * The os-eco overlay fold (SPEC §8.4 composition rule). The audit pipeline calls
 * {@link applyOsecoOverlay} on every non-skipped criterion's base verdict; it
 * merges os-eco-native evidence ({@link OSECO_OVERLAY}) over that verdict — pass
 * if either passes — without ever lowering a score. Kept out of the report
 * builder so the merge semantics live beside the detectors they fold.
 */
import { MAX_RATIONALE, type ScorecardEntry } from "../../scoring/index.ts";
import type { DetectionContext } from "../types.ts";
import { OSECO_OVERLAY } from "./evidence.ts";

/** Minimal criterion shape the overlay needs (id + scope) — mirrors the rubric record. */
export interface OverlayCriterion {
	id: string;
	scope: "repo" | "app";
}

/** Clip a rationale to the §6.2 ≤500-char cap. */
function clip(rationale: string): string {
	return rationale.length > MAX_RATIONALE ? `${rationale.slice(0, MAX_RATIONALE - 1)}…` : rationale;
}

/** True if `entry` is already a full pass (repo → 1/1; app → N/N, N ≥ 1). */
function isFullPass(entry: ScorecardEntry): boolean {
	return entry.numerator !== null && entry.denominator > 0 && entry.numerator === entry.denominator;
}

/**
 * Fold os-eco-native evidence (SPEC §8.4) over a criterion's base verdict: when
 * the deterministic/agent entry is not already a full pass and the os-eco adapter
 * finds positive evidence (seeds/mulch/canopy/plot/skills/check:all/ratchet), the
 * criterion passes with the evidence path named. Merges, never replaces — pass if
 * either passes. The evidence is repo-rooted, so the overlay runs once on the repo
 * context; an app-scope pass then projects uniformly onto all `N` apps (SPEC §7.1),
 * mirroring the agent-criterion path. No overlay for the criterion, or the toggle
 * off (`osecoDetectors: false`), is an exact no-op on `base`.
 */
export async function applyOsecoOverlay(
	criterion: OverlayCriterion,
	base: ScorecardEntry,
	repoCtx: DetectionContext,
	appCount: number,
): Promise<ScorecardEntry> {
	if (repoCtx.osecoDetectors === false) return base;
	const overlay = OSECO_OVERLAY[criterion.id];
	if (overlay === undefined || isFullPass(base)) return base;
	const result = await overlay(repoCtx);
	if (result.numerator !== 1) return base;
	const rationale = clip(result.rationale);
	return criterion.scope === "repo"
		? { numerator: 1, denominator: 1, rationale }
		: { numerator: appCount, denominator: appCount, rationale };
}
