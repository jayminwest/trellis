/**
 * Versioned data contracts (SPEC §6) — the boundary schemas every
 * deterministic-audit module shares: metric values, findings, safeguard
 * evidence, source coverage, the audit report, and the deterministic
 * measurement payload. Contracts only — analyzers (trellis-fbc5 and
 * siblings), scoring (trellis-00d5), and report assembly (trellis-ef85) are
 * downstream consumers.
 */
export { findingRangeSchema, findingSchema, positionSchema, relativePathSchema } from "./finding.ts";
export type { Finding, FindingRange, Position } from "./finding.ts";
export { metricValueSchema } from "./metric.ts";
export type { MetricValue } from "./metric.ts";
export {
	canonicalStringify,
	fingerprintPayload,
	measurementPayload,
} from "./payload.ts";
export type { MeasurementPayload } from "./payload.ts";
export {
	auditReportSchema,
	repoIdentitySchema,
	runMetadataSchema,
	scoreContributionSchema,
	scoreSchema,
} from "./report.ts";
export type {
	AuditReport,
	RepoIdentity,
	RunMetadata,
	Score,
	ScoreContribution,
} from "./report.ts";
export { EVIDENCE_LEVELS, safeguardLocationSchema, safeguardResultSchema } from "./safeguard.ts";
export type { EvidenceLevel, SafeguardLocation, SafeguardResult } from "./safeguard.ts";
export {
	SOURCE_SETS,
	setCoverageSchema,
	sourceCoverageSchema,
	sourceSetSchema,
} from "./source-coverage.ts";
export type { SetCoverage, SourceCoverage, SourceSet } from "./source-coverage.ts";
export { ANALYSIS_STATES, analysisStateSchema } from "./states.ts";
export type { AnalysisState } from "./states.ts";
export { SCHEMA_VERSION, SCORING_VERSION, versionStringSchema } from "./versions.ts";
export type { VersionString } from "./versions.ts";
