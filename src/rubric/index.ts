/** Rubric core (SPEC §6.1): record schemas, loader + invariants, version policy. */
export {
	loadRubric,
	type Rubric,
	RubricError,
} from "./loader.ts";
export {
	type CategoryRecord,
	type CriterionRecord,
	categoryRecordSchema,
	criterionRecordSchema,
	DISCOVERY_VIA,
	type DiscoveryVia,
	INVESTIGATION_AREAS,
	type InvestigationArea,
	SCOPES,
	type Scope,
} from "./schema.ts";
export {
	type CategorySummary,
	LEVELS,
	type Level,
	type LevelHistogram,
	type RubricSummary,
	summarizeRubric,
} from "./summary.ts";
export { comparable, RUBRIC_VERSION } from "./version.ts";
