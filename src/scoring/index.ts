/** Pure sloppiness scoring over native metrics. */

export {
	type ApportionPart,
	apportionPoints,
	clamp01,
	type FormulaDimension,
	type FormulaTerm,
	normalizeTerm,
	roundHalfUp,
	SCORING_FORMULA,
	type ScoringFormula,
} from "./formula.ts";
export {
	type DimensionScore,
	type DimensionState,
	type ScoredTerm,
	type SloppinessScore,
	scoreSloppiness,
} from "./sloppiness.ts";
