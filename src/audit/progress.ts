/**
 * Deterministic-audit progress events (SPEC §4, trellis-ef85) — the
 * structured, **bounded** signal the audit core emits while it walks the
 * one-directional pipeline:
 *
 *   configure → discover → parse → measure → safeguards → score → assemble
 *
 * "Bounded" is the contract: the number of events is a function of the
 * pipeline shape (7 phases, 4 metric analyzers), never of repository size —
 * a 10-file repo and a 10,000-file repo emit the same number of events, so
 * renderers can never be flooded by a large workspace.
 *
 * Events never alter control flow or the resulting report — a run with no
 * sink wired produces a byte-identical measurement payload (SPEC §3.5).
 */

/** The ordered pipeline stages {@link import("./audit.ts").auditWorkspace} walks. */
export type AuditPhase =
	| "configure"
	| "discover"
	| "parse"
	| "measure"
	| "safeguards"
	| "score"
	| "assemble";

/** The metric analyzers run in the `measure` phase, in execution order. */
export const ANALYZER_IDS = [
	"complexity",
	"duplication",
	"dependency-graph",
	"import-cycles",
] as const;

export type AnalyzerId = (typeof ANALYZER_IDS)[number];

/** A single observability event surfaced during an audit (never affects the report). */
export type AuditEvent =
	| { readonly type: "phase"; readonly phase: AuditPhase }
	| {
			readonly type: "source-discovered";
			readonly files: number;
			readonly packages: number;
			readonly excluded: number;
			readonly unsupported: number;
	  }
	| {
			readonly type: "syntax-built";
			readonly files: number;
			readonly functions: number;
			readonly diagnostics: number;
	  }
	| {
			readonly type: "analyzer";
			readonly id: AnalyzerId;
			readonly index: number;
			readonly total: number;
	  }
	| { readonly type: "measured"; readonly metrics: number; readonly findings: number }
	| {
			readonly type: "safeguards-inspected";
			readonly results: number;
			readonly findings: number;
	  }
	| { readonly type: "scored"; readonly index: number; readonly partial: boolean };

/** Optional sink for {@link AuditEvent}s; never affects the assembled report. */
export type AuditProgress = (event: AuditEvent) => void;
