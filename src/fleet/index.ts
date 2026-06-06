/**
 * Fleet layer (SPEC §6.5, §11) — the `targets.yaml` loader and multi-repo
 * orchestration over the same surface-agnostic audit core a single-repo run uses.
 *
 * Public surface: {@link loadFleet} (+ its schema/types and {@link targetAuditOptions}
 * mapping), {@link runFleet} (the orchestration entrypoint and its {@link FleetReport}
 * shape), and the {@link renderFleetTerminal}/{@link renderFleetMarkdown} dashboards.
 */
export {
	type FleetEntry,
	type FleetReport,
	type FleetRunDeps,
	type FleetTargetErr,
	type FleetTargetOk,
	runFleet,
} from "./orchestrate.ts";
export { renderFleetMarkdown, renderFleetTerminal } from "./report.ts";
export {
	type Fleet,
	type FleetDefaults,
	loadFleet,
	type ResolvedTarget,
	TARGETS_FILE,
	type TargetSpec,
	TargetsError,
	type TargetsFile,
	targetAuditOptions,
	targetsSchema,
} from "./targets.ts";
