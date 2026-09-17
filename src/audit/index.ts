/**
 * The deterministic audit core (SPEC §4, trellis-ef85).
 *
 * {@link auditWorkspace} is the one core call that audits a TS/TSX workspace
 * locally — no model, network, project command, Git, or database access —
 * and assembles the versioned §6.4 {@link import("../contract/index.ts").AuditReport}
 * from the shared parse and the deterministic analyzers. Report assembly
 * ({@link assembleReport}) is pure and validates the contract's cross-field
 * honesty invariants before a report leaves the core; progress events are
 * bounded by the pipeline shape, never by repository size.
 *
 * Persistence (trellis-424d), baseline comparison and failure policies
 * (trellis-942c), and renderers (trellis-a059) are downstream consumers of
 * this core — they live outside the measurement pass. {@link runWorkspaceAudit}
 * (trellis-9a88) is the service that composes them around the pure pass —
 * configuration, baseline resolution, policy assessment, opt-in history —
 * and is the one code path the CLI and SDK both fold (SPEC §13.1).
 */
export {
	type AssemblyMetadata,
	type AuditMeasurements,
	assembleReport,
	collectMetrics,
	orderFindings,
	reportCoverage,
} from "./assemble.ts";
export { type AuditCoreOptions, auditWorkspace } from "./audit.ts";
export {
	ANALYZER_IDS,
	type AnalyzerId,
	type AuditEvent,
	type AuditPhase,
	type AuditProgress,
} from "./progress.ts";
export {
	AuditRunError,
	runWorkspaceAudit,
	type WorkspaceAuditOptions,
	type WorkspaceAuditResult,
} from "./run.ts";
