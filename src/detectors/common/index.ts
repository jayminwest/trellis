/**
 * Language-agnostic detectors (SPEC §8, §5.4/§5.5/§5.7/§5.8) — the common HOW.
 *
 * Each export is a {@link Detector} keyed in `registry.ts` to one criterion id.
 * They depend only on the read-only {@link DetectionContext}, so they apply to
 * any language. This barrel re-exports the detector functions; the criterion →
 * detector wiring (and the {@link import("../registry.ts")} bindings) lives in
 * the registry so the dependency stays one-directional (registry → common).
 */

export {
	buildPerformanceTracking,
	deadFeatureFlagDetection,
	dependencyUpdateAutomation,
	deploymentFrequency,
	fastCiFeedback,
	featureFlagInfrastructure,
	monorepoTooling,
	progressiveRollout,
	releaseAutomation,
	releaseNotesAutomation,
	rollbackAutomation,
	vcsCliTools,
	versionDriftDetection,
} from "./ci-release.ts";
export {
	depsPinned,
	devcontainer,
	envTemplate,
	gitignoreComprehensive,
} from "./environment.ts";
export {
	automatedPrReview,
	backlogHealth,
	codeowners,
	issueLabelingSystem,
	issueTemplates,
	prTemplates,
} from "./process.ts";
export {
	largeFileDetection,
	preCommitHooks,
	techDebtTracking,
} from "./quality.ts";
export {
	automatedSecurityReview,
	branchProtection,
	minReleaseAge,
	privacyCompliance,
	secretScanning,
} from "./security.ts";
export {
	anyWorkflowMatches,
	firstHit,
	globHits,
	packageDeps,
	packageScripts,
	readJson,
	readWorkflows,
	type WorkflowFile,
} from "./util.ts";
