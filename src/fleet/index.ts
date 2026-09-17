/**
 * Fleet layer (SPEC §11) — the `targets.yaml` loader and multi-repo
 * orchestration over the same deterministic audit core a single-repo run
 * uses. Canonical-config drift rides along as a separate, non-scoring
 * capability; it never enters the sloppiness index or the exit policy.
 *
 * Public surface: {@link loadFleet} (+ its schema/types and the
 * {@link targetDriftOptions} mapping), {@link runFleet} (the orchestration
 * entrypoint and its {@link FleetReport} shape), {@link runFleetTargets} (the
 * service the CLI/SDK fold), {@link assessFleet} (the exit-code rollup), and
 * the {@link renderFleetTerminal}/{@link renderFleetMarkdown} views.
 */
export { assessFleet, type FleetAssessment } from "./assess.ts";
export {
	type FleetEntry,
	type FleetReport,
	type FleetRunDeps,
	type FleetTargetErr,
	type FleetTargetOk,
	runFleet,
} from "./orchestrate.ts";
export { renderFleetMarkdown, renderFleetTerminal } from "./report.ts";
export { type FleetRunOptions, runFleetTargets } from "./run.ts";
export {
	type Fleet,
	type FleetDefaults,
	loadFleet,
	type ResolvedTarget,
	TARGETS_FILE,
	type TargetSpec,
	TargetsError,
	type TargetsFile,
	targetDriftOptions,
	targetsSchema,
} from "./targets.ts";
