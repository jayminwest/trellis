/**
 * Agent-criterion → scorecard projection (SPEC §7.3, §6.2). Given an area's
 * resolved findings, these pure helpers turn one agent-discovery criterion into
 * its §6.2 entry: the deterministic grader's verdict projected onto the
 * criterion's scope (repo → 1, app → N), or an honest `no-detector` when the
 * area is unavailable / no investigation was wired — **never a fabricated pass**.
 *
 * Extracted from the audit pipeline (`build.ts`) so that file stays focused on
 * wiring stages together; the projection logic lives here as small, testable
 * units.
 */

import {
	type AreaId,
	type AreaResolution,
	type Grade,
	gradeCriterion,
} from "../investigation/index.ts";
import type { CriterionRecord, Rubric } from "../rubric/index.ts";
import { MAX_RATIONALE, type ScorecardEntry } from "../scoring/index.ts";

/** Rationale stamped on agent criteria when no investigation is wired into the audit. */
export const AGENT_NOT_WIRED = "investigation layer not wired for this run";

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
export function agentEntry(
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
export function neededAreas(rubric: Rubric): AreaId[] {
	const set = new Set<AreaId>();
	for (const c of rubric.criteria) {
		if (c.discoveryVia === "agent" && c.investigation !== null) set.add(c.investigation as AreaId);
	}
	return [...set];
}
