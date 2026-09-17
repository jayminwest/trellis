/**
 * Evidence shaping for normalized jscpd observations (plan `pl-43c5` —
 * trellis-da4c, step 13; called by `./normalize.ts`).
 *
 * This module turns canonicalized clone records (both member locations
 * plus the raw record, from `./normalize.ts`) into the contract's evidence
 * units and their unscored, namespaced products:
 *
 * - **Pairs** — the provider's unit: two distinct, deterministically
 *   ordered member locations, match mode from the record's own raw kind,
 *   raw facts (format, lines, tokens, near-miss method/similarity)
 *   preserved on the finding.
 * - **Groups** — only ever built by `./normalize.ts` from a proven
 *   content-equivalence class; this module shapes the class into one
 *   group: unique members in total location order, match mode graded at
 *   the weakest relation proven for all members, contributing raw kinds
 *   and the exhibited content's line count recorded on the finding.
 * - **Metrics** — namespaced (`provider.jscpd.…`), unscored, sorted by
 *   id: affected code lines per measured source set (union count over the
 *   set's own code-classified denominator) and the separate pair/group
 *   counts (distinct units, never equated or summed).
 * - **Raw totals** — the provider's own statistics retained for
 *   explanation only, with the volatile `detectionDate` excluded and
 *   format keys canonically ordered; nothing semantic is dropped.
 *
 * Member ordering is **total**: the contract's location order, then the
 * end/start columns it leaves unordered — so reordered raw reports never
 * change member order, and locations equal under the total order are
 * byte-identical.
 */
import {
	type CloneEvidence,
	type CloneGroupEvidence,
	type CloneLocation,
	type ClonePair,
	compareCloneLocations,
	type Finding,
	type MetricValue,
	namespacedEvidenceId,
} from "../../contract/index.ts";
import type { JscpdLineAccount } from "./lines.ts";
import {
	JSCPD_PROVIDER_ID,
	MATCH_MODE_BY_RAW_KIND,
	type RawJscpdClone,
	type RawJscpdFormatStatistics,
	type RawJscpdReport,
} from "./raw.ts";

/** The provider's own totals, retained for explanation only (never trellis accounting). */
export interface JscpdRawTotals {
	/** The tool's total accounting, in its own units. */
	total: RawJscpdFormatStatistics;
	/** The tool's per-format accounting, keys sorted canonically. */
	formats: Record<string, RawJscpdFormatStatistics>;
}

/** One canonicalized clone record: both member locations plus the raw record. */
export interface CanonicalClone {
	first: CloneLocation;
	second: CloneLocation;
	record: RawJscpdClone;
}

/** One normalized entry: the contract evidence plus its namespaced finding. */
export interface NormalizedEntry {
	evidence: CloneEvidence;
	finding: Finding;
}

/** The provider id prefix every evidence id this module emits carries. */
const EVIDENCE_IDS = {
	pairKind: "clone-pair",
	groupKind: "clone-group",
	affectedLines: (set: string) => `duplication.affected-code-lines.${set}`,
	pairs: "duplication.clone-pairs",
	groups: "duplication.clone-groups",
} as const;

/** One location as a compact human-readable span. */
function describe(location: CloneLocation): string {
	return `${location.path}:${location.range.start.line}-${location.range.end.line}`;
}

/**
 * Total order over member locations: the contract's deterministic order,
 * then the end/start columns the contract comparator leaves unordered, so
 * reordered raw reports never change member order. Locations equal under
 * this order are byte-identical.
 */
export function compareMembersTotal(a: CloneLocation, b: CloneLocation): number {
	const byContract = compareCloneLocations(a, b);
	if (byContract !== 0) {
		return byContract;
	}
	const endA = a.range.end.column ?? 0;
	const endB = b.range.end.column ?? 0;
	if (endA !== endB) {
		return endA - endB;
	}
	const serializedA = JSON.stringify([a.path, a.range]);
	const serializedB = JSON.stringify([b.path, b.range]);
	return serializedA < serializedB ? -1 : serializedA > serializedB ? 1 : 0;
}

/** The physical line count of exhibited content (a trailing newline ends, not spans, a line). */
export function fragmentLineCount(fragment: string): number {
	const lines = fragment.split("\n");
	return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

/** The member list findings share (path plus full range, columns preserved). */
function memberFacts(evidence: CloneEvidence): { path: string; range: CloneLocation["range"] }[] {
	return evidence.members.map((member) => ({ path: member.path, range: member.range }));
}

/** The first member location of an entry (evidence is constructed with sorted members). */
export function firstMemberOf(evidence: CloneEvidence): CloneLocation {
	const first = evidence.members[0];
	if (first === undefined) {
		throw new Error("clone evidence must carry at least one member");
	}
	return first;
}

/** The pair entry for one record: members in deterministic location order, raw facts preserved. */
export function pairEntry(clone: CanonicalClone): NormalizedEntry {
	const members = [clone.first, clone.second].sort(compareMembersTotal);
	const first = members[0];
	const second = members[1];
	if (first === undefined || second === undefined) {
		throw new Error("a clone pair requires two member locations");
	}
	const evidence: ClonePair = {
		kind: "pair",
		matchMode: MATCH_MODE_BY_RAW_KIND[clone.record.kind],
		members: [first, second],
	};
	return {
		evidence,
		finding: {
			kind: namespacedEvidenceId(JSCPD_PROVIDER_ID, EVIDENCE_IDS.pairKind),
			path: first.path,
			range: first.range,
			summary: `jscpd ${evidence.matchMode} clone pair (${describe(first)} ~ ${describe(second)})`,
			facts: {
				matchMode: evidence.matchMode,
				rawKind: clone.record.kind,
				format: clone.record.format,
				lines: clone.record.lines,
				tokens: clone.record.tokens,
				isNew: clone.record.isNew,
				...(clone.record.method === undefined ? {} : { method: clone.record.method }),
				...(clone.record.similarity === undefined ? {} : { similarity: clone.record.similarity }),
				members: memberFacts(evidence),
			},
		},
	};
}

/** The group entry for one proven fragment class (see `./normalize.ts` for the relation). */
export function groupEntry(
	fragment: string,
	classRecords: readonly CanonicalClone[],
): NormalizedEntry {
	const members = classRecords
		.flatMap((clone) => [clone.first, clone.second])
		.sort(compareMembersTotal);
	const unique: CloneLocation[] = [];
	for (const member of members) {
		const previous = unique[unique.length - 1];
		if (previous === undefined || compareMembersTotal(previous, member) !== 0) {
			unique.push(member);
		}
	}
	const allExact = classRecords.every((clone) => clone.record.kind === "exact");
	const evidence: CloneGroupEvidence = {
		kind: "group",
		matchMode: allExact ? "exact" : "normalized",
		members: unique,
	};
	const first = firstMemberOf(evidence);
	return {
		evidence,
		finding: {
			kind: namespacedEvidenceId(JSCPD_PROVIDER_ID, EVIDENCE_IDS.groupKind),
			path: first.path,
			range: first.range,
			summary: `jscpd ${evidence.matchMode} clone group: ${unique.length} locations of identical content`,
			facts: {
				matchMode: evidence.matchMode,
				memberCount: unique.length,
				rawKinds: [...new Set(classRecords.map((clone) => clone.record.kind))].sort(),
				contentLines: fragmentLineCount(fragment),
				members: memberFacts(evidence),
			},
		},
	};
}

/** Deterministic evidence order: first member, kind, size, then full members. */
export function compareEvidence(a: CloneEvidence, b: CloneEvidence): number {
	const byLocation = compareCloneLocations(firstMemberOf(a), firstMemberOf(b));
	if (byLocation !== 0) {
		return byLocation;
	}
	if (a.kind !== b.kind) {
		return a.kind < b.kind ? -1 : 1;
	}
	if (a.members.length !== b.members.length) {
		return a.members.length - b.members.length;
	}
	const serializedA = JSON.stringify(a.members);
	const serializedB = JSON.stringify(b.members);
	return serializedA < serializedB ? -1 : serializedA > serializedB ? 1 : 0;
}

/** The provider's own totals, volatility-excluded and canonically ordered. */
export function rawTotalsOf(report: RawJscpdReport): JscpdRawTotals {
	const formats: Record<string, RawJscpdFormatStatistics> = {};
	for (const [format, totals] of Object.entries(report.statistics.formats).sort(([a], [b]) =>
		a < b ? -1 : 1,
	)) {
		formats[format] = totals;
	}
	return { total: report.statistics.total, formats };
}

/** One affected-code-lines metric for a source set (union count over the set's own denominator). */
export function lineMetric(set: "production" | "test", account: JscpdLineAccount): MetricValue {
	return {
		id: namespacedEvidenceId(JSCPD_PROVIDER_ID, EVIDENCE_IDS.affectedLines(set)),
		state: "complete",
		value: account.affectedCodeLines,
		unit: "lines",
		...(account.codeLines > 0
			? { numerator: account.affectedCodeLines, denominator: account.codeLines }
			: {}),
		detail: { files: account.files },
	};
}

/** One count metric for a clone-evidence unit (pairs and groups are separate units). */
function countMetric(name: string, count: number): MetricValue {
	return {
		id: namespacedEvidenceId(JSCPD_PROVIDER_ID, name),
		state: "complete",
		value: count,
		unit: "count",
	};
}

/** The pair-count and group-count metrics: distinct units, never summed or equated. */
export function unitCountMetrics(pairCount: number, groupCount: number): MetricValue[] {
	return [countMetric(EVIDENCE_IDS.pairs, pairCount), countMetric(EVIDENCE_IDS.groups, groupCount)];
}
