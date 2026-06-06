/**
 * Report layer (SPEC §6.3) — the per-run audit document, its det-only pipeline,
 * and the three renderers. Public surface: {@link auditRepo} (the core
 * entrypoint the CLI/SDK fold), the {@link Report} shape, the render-time
 * {@link rollupByCategory}/{@link tally} folds, and {@link renderJson} /
 * {@link renderMarkdown} / {@link renderTerminal}.
 */
export { AGENT_NOT_WIRED, type AuditOptions, auditRepo } from "./build.ts";
export { renderJson } from "./json.ts";
export { renderMarkdown } from "./markdown.ts";
export { type CategoryRollup, pct, rollupByCategory, type Tally, tally } from "./rollup.ts";
export { renderTerminal } from "./terminal.ts";
export type { AppDescriptor, Report } from "./types.ts";
