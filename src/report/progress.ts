/**
 * Audit progress events (SPEC §7.3 observability) — the structured signal the
 * core emits during the (0.5–10min) audit run. The domain core ({@link
 * import("./build.ts").auditRepo}) emits these; the CLI renders them to stderr.
 * Defining them here keeps the contract surface-agnostic and `build.ts` lean.
 *
 * Events never alter control flow or the resulting report — a run with no sink
 * wired is byte-identical. Investigation events are lifted verbatim from the
 * agent pass (SPEC §7.3).
 */

import type { InvestigationEvent } from "../investigation/index.ts";

/** The ordered pipeline stages {@link import("./build.ts").auditRepo} walks (SPEC §14 milestone 3). */
export type AuditPhase = "discovery" | "investigation" | "detectors" | "scoring";

/** A single observability event surfaced during an audit (never affects the report). */
export type AuditEvent =
	| { readonly type: "phase"; readonly phase: AuditPhase }
	| { readonly type: "apps-discovered"; readonly count: number }
	| {
			readonly type: "detector";
			readonly id: string;
			readonly index: number;
			readonly total: number;
	  }
	| { readonly type: "investigation"; readonly event: InvestigationEvent };

/** Optional sink for {@link AuditEvent}s; never affects the resolved report. */
export type AuditProgress = (event: AuditEvent) => void;
