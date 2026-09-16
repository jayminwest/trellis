/**
 * Versioned measurement, finding, and audit-configuration contracts (SPEC §6).
 *
 * One schema version (`SCHEMA_VERSION`) covers the whole contract family —
 * metric values, findings, safeguard results, source coverage, the audit
 * report, and the declarative audit configuration (SPEC §3.5). This module
 * defines contracts only: analyzers (trellis-fbc5, …), the audit core
 * (trellis-ef85), and history (trellis-424d) consume them.
 */
export {
	type AuditConfig,
	auditConfigSchema,
	type MetricBudget,
	metricBudgetSchema,
	type PolicyConfig,
	policyConfigSchema,
	type SourceConfig,
	sourceConfigSchema,
} from "./config.ts";
export {
	COVERAGE_SCOPES,
	type CoverageScope,
	SOURCE_SETS,
	type SourceCoverage,
	type SourceCoverageEntry,
	type SourceSet,
	sourceCoverageEntrySchema,
	sourceCoverageSchema,
} from "./coverage.ts";
export {
	type Finding,
	findingSchema,
	type Position,
	positionSchema,
	type Range,
	rangeSchema,
} from "./finding.ts";
export { type MetricValue, metricValueSchema } from "./metric.ts";
export {
	dottedIdSchema,
	finiteNumberSchema,
	isRepoRelativePath,
	relativePathSchema,
	versionStringSchema,
} from "./primitives.ts";
export {
	type AuditReport,
	auditReportSchema,
	type MeasurementPayload,
	measurementPayload,
	type RepoMetadata,
	type RunMetadata,
	repoMetadataSchema,
	runMetadataSchema,
	type Score,
	type ScoreContribution,
	scoreContributionSchema,
	scoreSchema,
} from "./report.ts";
export {
	EVIDENCE_LEVELS,
	type EvidenceLevel,
	type SafeguardLocation,
	type SafeguardResult,
	safeguardLocationSchema,
	safeguardResultSchema,
} from "./safeguard.ts";
export {
	ANALYSIS_STATES,
	type AnalysisState,
	analysisStateSchema,
	type Completeness,
	completenessSchema,
	rollUpCompleteness,
} from "./states.ts";
export { ANALYZER_VERSION, SCHEMA_VERSION, SCORING_VERSION } from "./version.ts";
