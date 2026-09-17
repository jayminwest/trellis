/**
 * Deterministic-audit progress events (SPEC §4, trellis-ef85) — the
 * structured, **bounded** signal the audit core emits while it walks the
 * one-directional pipeline:
 *
 *   configure → discover → parse → measure → safeguards → score → assemble
 *
 * "Bounded" is the contract: the number of events is a function of the
 * pipeline shape (7 phases, the selected measured analyzers), never of
 * repository size — a 10-file repo and a 10,000-file repo emit the same
 * number of events, so renderers can never be flooded by a large workspace.
 *
 * Since the registry routing (trellis-1e66), the `measure` phase executes
 * the native capability registry's measured selection (`src/analysis/`),
 * so analyzer events derive from that selected execution list: one event
 * per selected analyzer, in execution order, with `index`/`total` from the
 * list itself. `ANALYZER_IDS` below is the explicit progress-id mirror of
 * that selection, and {@link analyzerProgressId} maps registry ids onto it
 * — the orchestration tests pin the mirror against the registry so the two
 * can never drift apart.
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

/**
 * The measured analyzers the `measure` phase runs, in execution order — the
 * progress-id mirror of the native capability registry's measured selection
 * (every registered analyzer that declares metrics, ordered prerequisites
 * first; the safeguard inspection declares none and runs in its own phase).
 */
export const ANALYZER_IDS = [
	"complexity",
	"dependency-graph",
	"duplication",
	"import-cycles",
] as const;

export type AnalyzerId = (typeof ANALYZER_IDS)[number];

/** The `trellis.` namespace every native registry analyzer id carries. */
const NATIVE_ID_NAMESPACE = "trellis.";

/**
 * The progress id of a native registry analyzer id (its id without the
 * `trellis.` namespace). Throws deterministically when the registry's
 * measured selection gains an analyzer this progress surface does not
 * mirror — the event contract stays explicit instead of silently widening.
 */
export function analyzerProgressId(registryId: string): AnalyzerId {
	const id = registryId.slice(NATIVE_ID_NAMESPACE.length);
	for (const known of ANALYZER_IDS) {
		if (known === id) return known;
	}
	throw new Error(`native analyzer "${registryId}" has no progress id in ANALYZER_IDS`);
}

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
