/**
 * Versioned measurement, finding, and audit-configuration contracts (SPEC §6)
 * plus the provider/analysis contracts for optional quality-evidence providers
 * (SPEC §16, plan `pl-43c5`).
 *
 * One schema version (`SCHEMA_VERSION`) covers the whole contract family —
 * metric values, findings, safeguard results, source coverage, the audit
 * report, the declarative audit configuration (SPEC §3.5), and the analysis
 * identity/coverage/result contracts (§16). This module defines contracts
 * only: analyzers (trellis-fbc5, …), the audit core (trellis-ef85), history
 * (trellis-424d), and the provider surfaces (pl-43c5) consume them.
 */
export * from "./analysis.ts";
export * from "./analysis-result.ts";
export {
	ARCHITECTURE_ALLOWANCES,
	ARCHITECTURE_POLICY_VERSION,
	type ArchitectureAllowance,
	type ArchitectureBoundaryRule,
	type ArchitectureCycleRule,
	type ArchitecturePathPattern,
	type ArchitectureRule,
	type ArchitectureScopeSelector,
	type ArchitectureUnresolvedRule,
	architectureAllowanceSchema,
	architectureBoundaryRuleSchema,
	architectureCycleRuleSchema,
	architecturePathPatternSchema,
	architectureRuleSchema,
	architectureScopeSelectorSchema,
	architectureUnresolvedRuleSchema,
	DEPENDENCY_EDGE_KINDS,
	type DependencyCruiserProviderRequest,
	type DependencyEdgeKind,
	dependencyCruiserProviderRequestSchema,
	dependencyEdgeKindSchema,
	MAX_ARCHITECTURE_PATTERN_LENGTH,
	MAX_ARCHITECTURE_RULE_NAME_LENGTH,
	MAX_ARCHITECTURE_RULES,
} from "./architecture-policy.ts";
export * from "./clone-evidence.ts";
export {
	type AuditConfig,
	auditConfigSchema,
	type MetricBudget,
	metricBudgetSchema,
	type PolicyConfig,
	policyConfigSchema,
	type RegressionPolicy,
	regressionPolicySchema,
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
	type EvidenceArea,
	evidenceAreaSchema,
	type ReportAnalysis,
	reportAnalysisSchema,
	rollUpEvidenceCompleteness,
	rollUpScoreCompleteness,
	SCORING_ROLES,
	type ScoringRole,
	scoringRoleSchema,
} from "./evidence.ts";
export {
	type Finding,
	findingSchema,
	type Position,
	positionSchema,
	type Range,
	rangeSchema,
} from "./finding.ts";
export {
	HOTSPOT_IDENTITY_VERSION,
	type HotspotIdentity,
	hotspotIdentitySchema,
} from "./hotspot-identity.ts";
export { type MetricValue, metricValueSchema } from "./metric.ts";
export {
	dottedIdSchema,
	finiteNumberSchema,
	isRepoRelativePath,
	relativePathSchema,
	versionStringSchema,
} from "./primitives.ts";
export {
	capabilityDeclarationsSchema,
	EVIDENCE_NAMESPACE,
	isNamespacedEvidenceId,
	NATIVE_NAMESPACE,
	namespacedEvidenceId,
	PRODUCER_KINDS,
	PROVIDER_STATES,
	type ProducerKind,
	type ProviderCapability,
	type ProviderIdentity,
	type ProviderOptions,
	type ProviderState,
	producerKindSchema,
	providerIdentitySchema,
	providerIdSchema,
	providerOptionsSchema,
	providerStateSchema,
} from "./provider.ts";
export {
	type KnipProviderRequest,
	knipProviderRequestSchema,
	MAX_REACHABILITY_ENTRY_FILES,
	MAX_REACHABILITY_EXPORT_NAME_LENGTH,
	MAX_REACHABILITY_PATH_LENGTH,
	MAX_REACHABILITY_PUBLIC_SURFACES,
	REACHABILITY_POLICY_VERSION,
	REACHABILITY_TEST_MODES,
	type ReachabilityPublicSurface,
	type ReachabilityTestMode,
	reachabilityExportNameSchema,
	reachabilityPathSchema,
	reachabilityPublicSurfaceSchema,
	reachabilityTestModeSchema,
} from "./reachability-policy.ts";
export {
	type AuditReport,
	auditReportSchema,
	carriedAnalyses,
	type EvidenceAuditReport,
	evidenceAuditReportSchema,
	type MeasurementPayload,
	measurementPayload,
	type PreProviderAuditReport,
	preProviderAuditReportSchema,
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
export {
	ANALYZER_VERSION,
	isSupportedSchemaVersion,
	PRE_IDENTITY_SCHEMA_VERSION,
	PRE_PROVIDER_SCHEMA_VERSION,
	SCHEMA_VERSION,
	SCORING_VERSION,
	SUPPORTED_SCHEMA_VERSIONS,
	type SupportedSchemaVersion,
} from "./version.ts";
