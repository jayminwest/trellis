/**
 * The provisional sloppiness score (SPEC §7, trellis-00d5) — a pure
 * function of the contract `MetricValue`s emitted by the analyzers
 * (`src/metrics/`). No filesystem, no configuration, no safeguard results:
 * same metrics in ⇒ byte-equal score out (SPEC §3.5), and policy budgets
 * can never mutate the versioned weights (`SCORING_FORMULA`, §6.5).
 *
 * Rules implemented here (all documented in SPEC §7.1):
 *
 * - Only the **production** source set is scored; test-set metrics never
 *   offset production debt. Import cycles are repo-level by construction.
 * - Every contribution is traceable: each dimension lists the raw metric
 *   ids, values, saturation thresholds, and blend shares that produced its
 *   points, and the contract `score` view references only metrics present
 *   in the input (§6.4 invariant).
 * - **Missing analysis is never zero debt**: a dimension whose required
 *   metrics are `incomplete`, `unsupported`, or absent scores at its full
 *   weight (worst case), and the headline is flagged `partial` — an
 *   apparently complete score is never published from partial analysis
 *   (§3.4). A `not-applicable` ratio with complete zero counts is a
 *   genuinely empty scope and scores 0; the companion count term (always
 *   finite when measured) independently confirms zero debt.
 * - `partial` is true when any input metric is `incomplete` or any required
 *   metric is absent. Callers pass the full analyzer metric set; the report
 *   assembler (trellis-ef85) must emit every metric so the §6.4 invariant
 *   (`partial` equals the report's completeness rollup) holds.
 * - The formula consumes only summed-mass repo metrics (§5.2 numerator/
 *   denominator sums). Per-package ratios in metric `detail` are
 *   explanatory and are never averaged into the index.
 */
import {
	type AnalysisState,
	type MetricValue,
	SCORING_VERSION,
	type Score,
} from "../contract/index.ts";
import {
	apportionPoints,
	type FormulaDimension,
	type FormulaTerm,
	normalizeTerm,
	roundHalfUp,
	SCORING_FORMULA,
} from "./formula.ts";

/** One scored term with its raw input and normalized value (0–100, exact). */
export interface ScoredTerm {
	metricId: string;
	/** False when the metric was absent from the input entirely. */
	present: boolean;
	/** The metric's analysis state, or `missing` when absent. */
	state: AnalysisState | "missing";
	/** The raw value consumed, or `null` when no value was available. */
	rawValue: number | null;
	saturatesAt: number;
	share: number;
	/** Normalized 0–100 (exact, unrounded); 100 on missing/incomplete (never zero debt). */
	normalized: number;
}

/** `scored` from raw metrics, or `degraded` to the worst case by missing analysis. */
export type DimensionState = "scored" | "degraded";

/** One dimension's traceable contribution to the index. */
export interface DimensionScore {
	dimension: string;
	weight: number;
	state: DimensionState;
	/** Exact normalized dimension score (0–100) before weighting. */
	normalized: number;
	/** Exact weighted points (`weight × normalized`). */
	exactPoints: number;
	/** Apportioned integer points; all dimensions' points sum exactly to the index. */
	points: number;
	/** Present input metrics this dimension consumed (sorted). */
	metricIds: string[];
	terms: ScoredTerm[];
	/** Deterministic human-readable trace from raw metrics to points. */
	explanation: string;
}

/** The full scoring result: the contract §6.4 `score` plus explanations. */
export interface SloppinessScore {
	scoringVersion: string;
	/** True while the formula awaits corpus calibration (SPEC §14). */
	provisional: true;
	direction: "lower-is-better";
	/** The 0–100 sloppiness index — LOWER IS BETTER, never a percentage of bad code (§3.4). */
	index: number;
	/** True when missing analysis prevents an apparently complete headline (§3.4). */
	partial: boolean;
	/** Required metric ids absent from the input (sorted). */
	missing: string[];
	/** Per-dimension contributions, sorted by dimension id. */
	dimensions: DimensionScore[];
	/** The contract-shaped §6.4 score (traceable to the report's metrics). */
	score: Score;
}

/** Deterministic number formatting for explanations (≤6 decimal places). */
function formatNumber(value: number): string {
	return String(Number(value.toFixed(6)));
}

/** Score one term against its metric, under the documented state rules. */
function scoreTerm(term: FormulaTerm, metric: MetricValue | undefined): ScoredTerm {
	const base = {
		metricId: term.metricId,
		saturatesAt: term.saturatesAt,
		share: term.share,
	};
	if (metric === undefined) {
		return { ...base, present: false, state: "missing", rawValue: null, normalized: 100 };
	}
	if (metric.state === "not-applicable") {
		return { ...base, present: true, state: metric.state, rawValue: null, normalized: 0 };
	}
	if (metric.state !== "complete" || metric.value === undefined) {
		const rawValue = metric.value ?? null;
		return { ...base, present: true, state: metric.state, rawValue, normalized: 100 };
	}
	return {
		...base,
		present: true,
		state: "complete",
		rawValue: metric.value,
		normalized: normalizeTerm(metric.value, term.saturatesAt),
	};
}

/** The deterministic per-term trace: `metricId value/saturation → normalized (×share)`. */
function termTrace(term: ScoredTerm): string {
	const raw = term.rawValue === null ? term.state : formatNumber(term.rawValue);
	return (
		`${term.metricId} ${raw}/${formatNumber(term.saturatesAt)} ` +
		`→ ${formatNumber(term.normalized)} (×${term.share})`
	);
}

/** The explanation for a degraded dimension (missing analysis is never zero debt). */
function degradedExplanation(dimension: string, terms: readonly ScoredTerm[]): string {
	const causes = terms
		.filter((term) => term.state !== "complete" && term.state !== "not-applicable")
		.map((term) => `${term.metricId} ${term.state}`)
		.join(", ");
	return (
		`${dimension} degraded (${causes}): scored at maximum 100 — ` +
		"missing analysis is never treated as zero debt"
	);
}

/** Score one dimension from the metric lookup. */
function scoreDimension(
	dimension: FormulaDimension,
	byId: ReadonlyMap<string, MetricValue>,
): DimensionScore {
	const terms = dimension.terms.map((term) => scoreTerm(term, byId.get(term.metricId)));
	const degraded = terms.some(
		(term) => term.state !== "complete" && term.state !== "not-applicable",
	);
	const normalized = degraded
		? 100
		: terms.reduce((sum, term) => sum + term.share * term.normalized, 0);
	const explanation = degraded
		? degradedExplanation(dimension.dimension, terms)
		: `${dimension.dimension} = weight ${dimension.weight} × normalized ${formatNumber(normalized)} [${terms.map(termTrace).join("; ")}]`;
	return {
		dimension: dimension.dimension,
		weight: dimension.weight,
		state: degraded ? "degraded" : "scored",
		normalized,
		exactPoints: dimension.weight * normalized,
		points: 0, // filled by apportionment in scoreSloppiness
		metricIds: terms
			.filter((term) => term.present)
			.map((term) => term.metricId)
			.sort(),
		terms,
		explanation,
	};
}

/**
 * Score the sloppiness index from raw contract metrics (see the module
 * docblock for the rules). Pure and synchronous; the input order does not
 * affect the result. Throws when the input carries duplicate metric ids —
 * a caller bug the deterministic pipeline must never paper over.
 */
export function scoreSloppiness(metrics: readonly MetricValue[]): SloppinessScore {
	const byId = new Map<string, MetricValue>();
	for (const metric of metrics) {
		if (byId.has(metric.id)) {
			throw new Error(`duplicate metric id "${metric.id}" in scoring input`);
		}
		byId.set(metric.id, metric);
	}
	const scored = SCORING_FORMULA.dimensions.map((dimension) => scoreDimension(dimension, byId));
	scored.sort((a, b) => (a.dimension < b.dimension ? -1 : 1));
	const missing = scored
		.flatMap((dimension) =>
			dimension.terms.filter((term) => !term.present).map((term) => term.metricId),
		)
		.sort();
	const partial = metrics.some((metric) => metric.state === "incomplete") || missing.length > 0;
	const total = scored.reduce((sum, dimension) => sum + dimension.exactPoints, 0);
	const index = Math.min(100, Math.max(0, roundHalfUp(total)));
	const apportioned = apportionPoints(
		total,
		scored.map((dimension) => ({ key: dimension.dimension, exact: dimension.exactPoints })),
	);
	const dimensions = scored.map((dimension) => ({
		...dimension,
		points: apportioned.get(dimension.dimension) ?? 0,
	}));
	return {
		scoringVersion: SCORING_VERSION,
		provisional: true,
		direction: "lower-is-better",
		index,
		partial,
		missing,
		dimensions,
		score: {
			index,
			direction: "lower-is-better",
			partial,
			contributions: dimensions.map((dimension) => ({
				dimension: dimension.dimension,
				points: dimension.points,
				metricIds: dimension.metricIds,
			})),
		},
	};
}
