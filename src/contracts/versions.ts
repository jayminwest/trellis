/**
 * Contract versioning (SPEC §3.5) — the three versions that travel with every
 * report, plus the version-string shape the schemas enforce.
 *
 *   - **Schema version**   — this contract's version ({@link SCHEMA_VERSION}).
 *   - **Scoring version**  — the sloppiness formula version
 *                            ({@link SCORING_VERSION}); provisional until the
 *                            fixed-corpus calibration lands (SPEC §7).
 *   - **Analyzer version** — the trellis release that produced the
 *                            measurements; bound to the package version by the
 *                            audit core (trellis-ef85), not duplicated here.
 *
 * Two reports are trend-comparable only when all three semantics are
 * compatible (SPEC §3.5); missing or malformed version data is a contract
 * violation, so every version field is required and validated.
 */
import { z } from "zod";

/** The §6 contract version every report and configuration carries. */
export const SCHEMA_VERSION = "1.0.0";

/** The §7 formula version — provisional pending fixed-corpus calibration. */
export const SCORING_VERSION = "0.1.0-provisional";

/**
 * Semver core with optional pre-release (`1.0.0`, `0.1.0-provisional`).
 * Build metadata is not accepted: versions identify semantics, not builds.
 */
export const versionStringSchema = z
	.string()
	.regex(
		/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/,
		"must be a semver version (optionally with a pre-release tag)",
	);

export type VersionString = z.infer<typeof versionStringSchema>;
