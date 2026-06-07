/**
 * Investigation core (SPEC §7): the four fixed areas, the per-area zod findings
 * contracts, and the pure deterministic grader (facts → pass/fail/N-A).
 *
 * The LLM execution layer (Pi RPC, §9) lives under `provider/` and depends only
 * on these contracts: "given a repo checkout and an area, return facts that
 * validate against that area's schema." Everything downstream (grader, scoring,
 * caching) is provider-agnostic.
 */
export {
	ALL_AREAS,
	AREA_IDS,
	AREAS,
	type Area,
	type AreaId,
	areaById,
} from "./areas.ts";
export {
	type AgentConfigFindings,
	type AreaFindings,
	agentConfigFindingsSchema,
	DEVCONTAINER_BUILD_EVIDENCE,
	type DocumentationFindings,
	documentationFindingsSchema,
	FINDINGS_SCHEMAS,
	FLAKY_HANDLING,
	INTEGRATION_BOUNDARIES,
	SECRETS_MECHANISM,
	type SetupRunnabilityFindings,
	setupRunnabilityFindingsSchema,
	type TestLayoutFindings,
	testLayoutFindingsSchema,
	VALIDATION_AUTOMATION,
} from "./findings.ts";
export {
	CRITERION_AREA,
	FRESH_THRESHOLD_DAYS,
	type Grade,
	gradeArea,
	gradeCriterion,
	gradedCriterionIds,
	SKIPPABLE_AGENT_CRITERIA,
} from "./grader.ts";
export type { SessionEvent } from "./provider/pi/session.ts";
export {
	type AreaResolution,
	type InvestigateFn,
	type InvestigationCache,
	type InvestigationContext,
	type InvestigationDeps,
	type InvestigationEvent,
	type InvestigationProgress,
	runInvestigation,
} from "./run.ts";
