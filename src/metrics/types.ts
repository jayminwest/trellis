/**
 * Complexity & erosion measurement types (SPEC §5.1–5.2, trellis-fbc5).
 *
 * This module family measures raw structural facts over the shared syntax
 * inventory (trellis-d81d): per-function cyclomatic complexity, maximum
 * nesting depth, and source size, plus structural erosion (complexity
 * weighted by size). It emits contract `MetricValue`s and `Finding`s
 * (trellis-58a6) — **no scoring**: size and nesting are explanatory signals
 * unless the scoring formula (trellis-00d5) explicitly includes them.
 *
 * Scope rules (binding, SPEC §3.1/§5.2):
 *
 * - Only `production` and `test` source sets are measured, and always
 *   **separately** — every metric id ends in the source set, and no number
 *   ever mixes the two.
 * - Aggregation functions → packages → repo scope uses **summed masses**,
 *   never averages of package percentages: a scope's eroded-mass share is
 *   `Σ eroded mass / Σ mass` over its functions, so a big package's erosion
 *   is never diluted by averaging it against tiny packages.
 * - Empty or function-free scopes produce documented finite values
 *   (counts, total mass: `0`) or `not-applicable` states (distributions,
 *   the eroded-mass share — a 0/0 ratio is meaningless), never crashes or
 *   silent zeros. A scope with parse diagnostics is `incomplete` with
 *   partial values instead — `not-applicable` never hides an analysis
 *   failure (SPEC §3.3).
 */
import type { HotspotIdentity } from "../contract/hotspot-identity.ts";
import type { Finding, MetricValue, Range, SourceSet } from "../contract/index.ts";
import type { FunctionKind } from "../syntax/index.ts";

/**
 * Functions with CC **strictly greater** than this threshold carry eroded
 * mass and surface as `complexity.hotspot` findings (SPEC §5.2 "CC > 10").
 */
export const EROSION_CC_THRESHOLD = 10;

/** One measured function: raw facts plus derived erosion mass. */
export interface FunctionMeasurement {
	identity: HotspotIdentity;
	/** Repo-relative POSIX path of the owning file. */
	path: string;
	/** Owning package root from discovery (`.` for the repo root). */
	packagePath: string;
	sourceSet: SourceSet;
	/** Display name from the syntax inventory (`(anonymous)` when unnamed). */
	name: string;
	kind: FunctionKind;
	/** Whole-node range (signature through closing brace), 1-based. */
	range: Range;
	/** Cyclomatic complexity per the decision table in `complexity.ts` (minimum 1). */
	cc: number;
	/** Maximum control-structure nesting per the rule in `complexity.ts` (0 for a flat body). */
	maxNesting: number;
	/**
	 * Code-classified lines within {@link range} (whole node, nested
	 * function bodies included — the documented size rule). Comment-only
	 * and blank lines never count; multiline literals count on every line
	 * they occupy (the syntax layer's scanner classification).
	 */
	sloc: number;
	/** `CC × sqrt(SLOC)` (SPEC §5.2), unrounded — round only at emission. */
	mass: number;
	/** True when `cc > EROSION_CC_THRESHOLD`. */
	eroded: boolean;
}

/** p50/p90/max of a non-empty CC sample (nearest-rank; see `erosion.ts`). */
export interface CcDistribution {
	p50: number;
	p90: number;
	max: number;
}

/**
 * Summed-mass aggregate over a set of functions in one package or one whole
 * source-set scope. `erodedShare` is `null` exactly when `mass === 0` (no
 * functions) — the ratio is then not-applicable, not `0`.
 */
export interface MassAggregate {
	/** Files contributing to this aggregate. */
	files: number;
	/** Sum of file code-line counts (file-level SLOC, not function ranges). */
	sloc: number;
	functionCount: number;
	mass: number;
	erodedMass: number;
	erodedCount: number;
	erodedShare: number | null;
}

/** One package's aggregate within a source-set scope. */
export interface PackageAggregate extends MassAggregate {
	packagePath: string;
}

/** One source set's aggregate: repo-level sums plus the per-package breakdown. */
export interface ScopeAggregate extends MassAggregate {
	sourceSet: SourceSet;
	/** Files in this scope that produced parse diagnostics (partial measurement). */
	diagnosticFiles: string[];
	cc: CcDistribution | null;
	maxNesting: number | null;
	/** Per-package aggregates, sorted by `packagePath`. */
	packages: PackageAggregate[];
}

/**
 * The full complexity & erosion measurement of one audit: per-function
 * facts, per-scope aggregates, contract metrics, and hotspot findings.
 */
export interface ComplexityAnalysis {
	/** Every measured function, in inventory (sorted path, then source) order. */
	functions: FunctionMeasurement[];
	scopes: {
		production: ScopeAggregate;
		test: ScopeAggregate;
	};
	/** Contract metric values (SPEC §6.1), sorted by id. Ids end in the source set. */
	metrics: MetricValue[];
	/**
	 * `complexity.hotspot` findings (SPEC §6.2) for every eroded function,
	 * ranked by mass (descending; ties by path, line, name) — production
	 * and test functions ranked in one deterministic order, with the source
	 * set carried in `facts`.
	 */
	findings: Finding[];
}
