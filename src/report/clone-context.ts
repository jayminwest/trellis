import type { Finding } from "../contract/index.ts";
import { lineOverlapSchema } from "../contract/line-overlap.ts";

/** Older/malformed/unknown facts are never interpreted as an observed absence. */
export function cloneReviewContext(finding: Finding): string {
	if (finding.kind !== "duplication.clone-group") return "";
	const parsed = lineOverlapSchema.safeParse(finding.facts?.lineOverlap);
	if (!parsed.success) return " · line overlap: unknown (metadata unavailable)";
	if (!parsed.data.overlaps) return "";
	return (
		" · line overlap: these matches overlap within one file; review the repeated structure " +
		"before treating them as separate implementations to consolidate. " +
		"Line overlap does not prove token overlap or semantic duplication; see JSON facts.lineOverlap for ranges."
	);
}
