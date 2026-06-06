/**
 * os-eco-native detectors (SPEC §8.4) — recognize os-eco conventions
 * (seeds/mulch/canopy/plot/skills/check:all/ratchets) as evidence for *existing*
 * rubric criteria so warren-stack repos score honestly. These do not bind in the
 * registry; the audit pipeline folds {@link OSECO_OVERLAY} over each base verdict
 * (pass if either passes), gated by the per-target `osecoDetectors` toggle.
 */
export {
	agenticDevelopment,
	agentsMd,
	apiSchemaDocs,
	automatedDocGen,
	codeQualityMetrics,
	deadCode,
	documentationFreshness,
	duplicateCode,
	heavyDeps,
	largeFile,
	OSECO_OVERLAY,
	seedsBacklog,
	seedsIssueTemplates,
	seedsLabeling,
	skills,
	techDebt,
	unusedDeps,
} from "./evidence.ts";
export { applyOsecoOverlay, type OverlayCriterion } from "./overlay.ts";
