/**
 * Report layer (SPEC §6.3) — the per-run audit document, its det-only pipeline,
 * and the three renderers. Public surface: {@link auditRepo} (the core
 * entrypoint the CLI/SDK fold), the {@link Report} shape, the render-time
 * {@link rollupByCategory}/{@link tally} folds, and {@link renderJson} /
 * {@link renderMarkdown} / {@link renderTerminal}.
 */
export {
	type Assessment,
	activeChecks,
	assessReport,
	DEFAULT_MIN_LEVEL,
	FAIL_ON_MODES,
	type FailOnMode,
	type FailPolicy,
	failingGateIds,
} from "./assess.ts";
export { AGENT_NOT_WIRED, type AuditOptions, auditRepo, SKIPPED_VIA_TARGETS } from "./build.ts";
export { changesSinceLastRun, criterionStatus, snapshot } from "./changes.ts";
export { renderJson } from "./json.ts";
export { renderMarkdown } from "./markdown.ts";
export type { AuditEvent, AuditPhase, AuditProgress } from "./progress.ts";
export { type CategoryRollup, pct, rollupByCategory, type Tally, tally } from "./rollup.ts";
export { type AuditRunOptions, runAudit } from "./run.ts";
export { renderTerminal } from "./terminal.ts";
export type {
	AppDescriptor,
	ChangesSinceLastRun,
	CriterionSnapshot,
	CriterionStatus,
	CriterionTransition,
	Report,
	TransitionKind,
} from "./types.ts";
