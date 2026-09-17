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
 *
 * Version-aware reading (SPEC §16.6, trellis-a24d): this trellis reads every
 * version in {@link SUPPORTED_SCHEMA_VERSIONS} and no others. Each version
 * keeps its own interpretation — a pre-provider report (1.0.0) never reads
 * as carrying provider provenance — and an unknown or newer-incompatible
 * version fails actionably instead of loading with guessed semantics.
 */
import { VERSION } from "../index.ts";

/** Analyzer version: the trellis release (package version). */
export const ANALYZER_VERSION = VERSION;

/** Scoring version: the provisional formula (SPEC §7); trellis-00d5 owns the formula itself. */
export const SCORING_VERSION = "0.2.0-provisional";

/**
 * Schema version for the §6 report/configuration contract family.
 *
 * `1.1.0` (trellis-a24d) adds the additive per-analysis evidence area
 * (§6.6): per-analysis provenance/status, overall evidence completeness
 * independent of score completeness, and score completeness computed only
 * from the report's declared scored inputs. Native metric values and the
 * scoring formula are unchanged.
 */
export const SCHEMA_VERSION = "1.1.0";

/**
 * The pre-provider schema version (`1.0.0`): reports from before the evidence
 * area. Still readable with its original interpretation — completeness is
 * the metric-state rollup, `score.partial` folds into it, and the report is
 * never relabeled as carrying provider provenance (§16.6).
 */
export const PRE_PROVIDER_SCHEMA_VERSION = "1.0.0";

/** Every schema version this trellis reads, oldest first (§16.6). */
export const SUPPORTED_SCHEMA_VERSIONS = [PRE_PROVIDER_SCHEMA_VERSION, SCHEMA_VERSION] as const;

/** One readable schema version. */
export type SupportedSchemaVersion = (typeof SUPPORTED_SCHEMA_VERSIONS)[number];

/** Whether `version` names a schema version this trellis reads (§16.6). */
export function isSupportedSchemaVersion(version: string): version is SupportedSchemaVersion {
	return (SUPPORTED_SCHEMA_VERSIONS as readonly string[]).includes(version);
}
