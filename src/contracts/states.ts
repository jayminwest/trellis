/**
 * Analysis states (SPEC §3.3) — the explicit state every measurement and every
 * report carries. The four states are load-bearing product semantics:
 *
 *   - `complete`       — the measurement ran over its full intended scope.
 *   - `incomplete`     — part of the scope could not be analyzed (parse errors,
 *                        unresolved imports, resource exhaustion); the reason
 *                        travels with the measurement.
 *   - `unsupported`    — the source is outside the analyzed language set
 *                        (non-TS/TSX); reported as coverage, never cleanliness.
 *   - `not-applicable` — the measurement is genuinely meaningless for the
 *                        scope; documented per metric, never hides a failure.
 */
import { z } from "zod";

/** The four analysis states (SPEC §3.3), in canonical order. */
export const ANALYSIS_STATES = ["complete", "incomplete", "unsupported", "not-applicable"] as const;

/** One analysis state (SPEC §3.3). */
export type AnalysisState = (typeof ANALYSIS_STATES)[number];

/** zod schema for an {@link AnalysisState}. */
export const analysisStateSchema = z.enum(ANALYSIS_STATES);
