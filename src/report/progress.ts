/**
 * Audit progress events — the structured signal the core emits during the audit
 * run. The domain core ({@link import("./build.ts").auditRepo}) emits these; the
 * CLI renders them to stderr. Defining them here keeps the contract
 * surface-agnostic and `build.ts` lean.
 *
 * Events never alter control flow or the resulting report — a run with no sink
 * wired is byte-identical.
 */

/** The ordered pipeline stages {@link import("./build.ts").auditRepo} walks. */
export type AuditPhase = "discovery" | "detectors" | "scoring";

/** A single observability event surfaced during an audit (never affects the report). */
export type AuditEvent =
	| { readonly type: "phase"; readonly phase: AuditPhase }
	| { readonly type: "apps-discovered"; readonly count: number }
	| {
			readonly type: "detector";
			readonly id: string;
			readonly index: number;
			readonly total: number;
	  };

/** Optional sink for {@link AuditEvent}s; never affects the resolved report. */
export type AuditProgress = (event: AuditEvent) => void;
