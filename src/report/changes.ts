/**
 * Changes-since-last-run (SPEC §11) — the per-criterion delta between a run and
 * the most recent prior run **for the same repo**. Pure functions over two
 * {@link Report}s: {@link changesSinceLastRun} classifies every criterion's move
 * (pass↔fail, N/A-kind shifts, app-count/denominator changes, added/removed)
 * and the net level move, then attributes the whole delta.
 *
 * **Attribution (SPEC §11):** because each run records its `rubricVersion`, a
 * level move is attributable. Identical versions ⇒ the delta is a real code
 * regression/improvement (`"code"`); differing versions ⇒ it may be rubric-driven
 * and is flagged `"possibly-rubric"` so a reader never mistakes a rubric edit for
 * a code change.
 *
 * This module is embedded in the §6.3 report at audit time (see
 * {@link auditRepo}) and rendered by `trellis report`; it depends only on the
 * report shape, so it stays free of any store/SQLite coupling.
 */
import type { ScorecardEntry } from "../scoring/index.ts";
import type {
	ChangesSinceLastRun,
	CriterionSnapshot,
	CriterionStatus,
	CriterionTransition,
	Report,
	TransitionKind,
} from "./types.ts";

/** Fold a §6.2 entry to its coarse {@link CriterionStatus}. */
export function criterionStatus(entry: ScorecardEntry): CriterionStatus {
	if (entry.naKind !== undefined) return entry.naKind;
	if (entry.numerator === entry.denominator) return "pass";
	if (entry.numerator === 0) return "fail";
	return "partial";
}

/** Snapshot a §6.2 entry for a transition's before/after. */
export function snapshot(entry: ScorecardEntry): CriterionSnapshot {
	return {
		status: criterionStatus(entry),
		numerator: entry.numerator,
		denominator: entry.denominator,
		naKind: entry.naKind ?? null,
	};
}

/** True when two snapshots are measurably identical (no transition to report). */
function snapshotsEqual(a: CriterionSnapshot, b: CriterionSnapshot): boolean {
	return (
		a.status === b.status &&
		a.numerator === b.numerator &&
		a.denominator === b.denominator &&
		a.naKind === b.naKind
	);
}

/**
 * Classify a both-present criterion's move into a single {@link TransitionKind},
 * or `null` when nothing measurable changed. Priority — N/A-kind shifts win, then
 * full-pass boundary crossings, then denominator (app-count) moves, then a
 * within-partial numerator move — so each transition carries the most salient label.
 */
function classify(before: CriterionSnapshot, after: CriterionSnapshot): TransitionKind | null {
	if (snapshotsEqual(before, after)) return null;
	if (before.naKind !== after.naKind) return "na-kind";
	// Both counted from here (naKind equal ⇒ both null).
	if (before.status === "pass" && after.status !== "pass") return "pass-to-fail";
	if (after.status === "pass" && before.status !== "pass") return "fail-to-pass";
	if (before.denominator !== after.denominator) return "denominator";
	return "score";
}

/**
 * Compute the §11 delta of `current` against the prior run `previous` (the most
 * recent run for the same repo). Walks `current`'s criteria in rubric order
 * emitting a transition for every criterion that moved, appends any criteria the
 * prior run had that this one dropped (`removed`), and attributes the whole delta
 * by comparing rubric versions.
 */
export function changesSinceLastRun(current: Report, previous: Report): ChangesSinceLastRun {
	const transitions: CriterionTransition[] = [];

	for (const [criterion, entry] of Object.entries(current.criteria)) {
		const prior = previous.criteria[criterion];
		const after = snapshot(entry);
		if (prior === undefined) {
			transitions.push({ criterion, kind: "added", before: null, after });
			continue;
		}
		const before = snapshot(prior);
		const kind = classify(before, after);
		if (kind !== null) transitions.push({ criterion, kind, before, after });
	}

	for (const [criterion, entry] of Object.entries(previous.criteria)) {
		if (current.criteria[criterion] === undefined) {
			transitions.push({ criterion, kind: "removed", before: snapshot(entry), after: null });
		}
	}

	const rubricVersionChanged = current.rubricVersion !== previous.rubricVersion;
	return {
		previousScoredAt: previous.scoredAt,
		previousCommit: previous.commit,
		previousRubricVersion: previous.rubricVersion,
		previousLevel: previous.level,
		level: current.level,
		netLevelMove: current.level - previous.level,
		rubricVersionChanged,
		attribution: rubricVersionChanged ? "possibly-rubric" : "code",
		transitions,
	};
}
