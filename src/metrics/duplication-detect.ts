/** The single native token-stream backend (SPEC §5.3; trellis-e55c).
 * The validated core also owns collection/accounting for workspace audits.
 */
import {
	type CloneDetection,
	DEFAULT_DUPLICATION_BUDGET,
	type DuplicationBudget,
	locateBudgetExhaustion,
	type TokenStream,
} from "./duplication.ts";
import { detectCandidateClones } from "./duplication-candidate.ts";

export function detectClones(
	streams: readonly TokenStream[],
	budget: DuplicationBudget = DEFAULT_DUPLICATION_BUDGET,
): CloneDetection {
	const result = detectCandidateClones(streams, budget);
	return {
		groups: result.groups,
		tokenCount: result.tokenCount,
		exhaustion: locateBudgetExhaustion(result.exhaustion),
	};
}
