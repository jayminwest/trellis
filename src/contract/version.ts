/**
 * Contract version constants (SPEC §3.5, §6).
 *
 * Three versions travel with every report:
 *
 * - **Analyzer version** — the trellis release that produced the measurements;
 *   aliased from the package `VERSION` so the two can never drift apart.
 * - **Scoring version** — the provisional-formula version (SPEC §7). The
 *   formula itself lands with trellis-00d5; the constant is pinned here so
 *   reports already carry a stable value, and any recalibration bumps it
 *   together with its test expectations.
 * - **Schema version** — the report/configuration contract version (§6). One
 *   version covers the whole §6 contract family (metrics, findings,
 *   safeguards, coverage, report, configuration); any breaking contract
 *   change bumps it.
 */
import { VERSION } from "../index.ts";

/** Analyzer version: the trellis release (package version). */
export const ANALYZER_VERSION = VERSION;

/** Scoring version: the provisional formula (SPEC §7); trellis-00d5 owns the formula itself. */
export const SCORING_VERSION = "0.1.0-provisional";

/** Schema version for the §6 report/configuration contract family. */
export const SCHEMA_VERSION = "1.0.0";
