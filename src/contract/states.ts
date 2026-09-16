/**
 * Analysis states (SPEC §3.3) — the honesty layer of every measurement.
 *
 * - `complete` — the measurement ran over its full intended scope.
 * - `incomplete` — part of the scope could not be analyzed (parse errors,
 *   unresolved imports, resource exhaustion); the report says what and where.
 * - `unsupported` — the source is outside the analyzed language set;
 *   reported as coverage, never cleanliness.
 * - `not-applicable` — the measurement is genuinely meaningless for the
 *   scope; documented per metric, never used to hide an analysis failure.
 */
import { z } from "zod";

export const ANALYSIS_STATES = ["complete", "incomplete", "unsupported", "not-applicable"] as const;
export type AnalysisState = (typeof ANALYSIS_STATES)[number];

export const analysisStateSchema = z.enum(ANALYSIS_STATES);

/**
 * Report-level completeness (SPEC §6.4): rolled up from metric states.
 * Any `incomplete` metric makes the report `incomplete`; `unsupported` and
 * `not-applicable` are honest states and do not degrade completeness.
 */
export type Completeness = "complete" | "incomplete";

export const completenessSchema = z.enum(["complete", "incomplete"]);

export function rollUpCompleteness(states: readonly AnalysisState[]): Completeness {
	return states.includes("incomplete") ? "incomplete" : "complete";
}
