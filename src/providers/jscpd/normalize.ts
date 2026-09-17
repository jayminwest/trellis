/**
 * Normalization of validated jscpd observations into stable clone evidence
 * and trellis-owned line accounting (SPEC §16.5, plan `pl-43c5` —
 * trellis-da4c, step 13).
 *
 * Input: one schema-validated raw report (`./raw.ts`, step 12) plus the
 * accounted selection it was validated against (the staged files, as
 * `./lines.ts` accounted files). Output: contract clone evidence
 * (`src/contract/clone-evidence.ts`), namespaced unscored metrics and
 * findings, the per-source-set line accounts, and the provider's own totals
 * retained for explanation only. Pure: no process, no filesystem, no audit
 * wiring (step 15 owns integration).
 *
 * **Exact semantics:**
 *
 * - **Path roots canonicalized.** A reported clone name is mapped onto the
 *   accounted selection: separators normalized to POSIX, a leading `./`
 *   stripped, then an exact path match — else the *longest* suffix match
 *   (root-prefixed names canonicalize onto repo-relative paths) — else an
 *   operational error (validated evidence always resolves).
 * - **Every reported clone counts.** Both members of every record enter the
 *   line accounting — union over code-classified lines, once per file, per
 *   source set — including records presented as groups and degenerate ones.
 * - **Pairs are the provider's unit.** Each record that does not join a
 *   group becomes one pair: members deterministically ordered, match mode
 *   from the record's own raw kind (`exact`/`renamed`/`similar` →
 *   exact/normalized/near), locations preserved with the tool's reported
 *   line spans and character columns (its own 0-based offsets shifted to
 *   1-based), raw facts preserved on the finding (`./evidence.ts`).
 * - **Groups only for proven shared content equivalence.** A group forms
 *   only when **two or more records of kind `exact` or `renamed` report a
 *   byte-identical `fragment`** — the report itself exhibits one content
 *   shared across records, and token/normalized identity is transitive, so
 *   the fragment class is a proven content-equivalence relation. The group
 *   carries every member location, and its match mode is `exact` only when
 *   every contributing record is `exact`, else `normalized` (the weakest
 *   relation proven for all members). A group *replaces* its records'
 *   pairs — the same clones are never double-represented.
 * - **Near matches never merge.** Records of kind `similar` never form or
 *   join groups: similarity is nontransitive, and classes are never built
 *   by connected components over pairs. Near evidence is pair-only.
 * - **Pairs and groups stay distinct units.** Their counts are separate
 *   metrics, never summed, never equated with each other or with the raw
 *   record count (the raw totals keep that reconciliation visible).
 * - **Provider totals are explanation only.** `rawTotals` retains the
 *   tool's own accounting (its duplicated lines, its percentages, its
 *   source counts) with the volatile `detectionDate` excluded; nothing
 *   semantic is dropped, and unknown fields cannot occur — the raw schema
 *   is strict, so nothing is ever silently deleted. The tool's percentage
 *   is never imported as trellis density: the trellis metric is the
 *   union-of-affected-code-lines count over the accounted selection's own
 *   code-classified denominator.
 * - **Degenerate records stay visible.** A record whose two members
 *   canonicalize to the same location (the pinned tool never reports one)
 *   cannot be pair or group evidence — the contract units require distinct
 *   members — so it contributes only its lines and is counted in
 *   `degenerateRecords`, never silently dropped. The one exception is a
 *   degenerate record whose fragment class forms a group: the group then
 *   carries its location as a member, exactly like its non-degenerate
 *   classmates.
 *
 * Unscored: none of this enters the sloppiness index; metric states
 * describe the normalized evidence itself — run-level coverage and state
 * honesty live on the analysis result the adapter assembles (steps 12/15).
 */
import type { CloneEvidence, CloneLocation, Finding, MetricValue } from "../../contract/index.ts";
import { compareCloneLocations } from "../../contract/index.ts";
import {
	type CanonicalClone,
	compareEvidence,
	groupEntry,
	type JscpdRawTotals,
	lineMetric,
	type NormalizedEntry,
	pairEntry,
	rawTotalsOf,
	unitCountMetrics,
} from "./evidence.ts";
import {
	accountCloneLines,
	InvalidJscpdEvidenceError,
	type JscpdAccountedFile,
	type JscpdCloneMemberSpan,
	type JscpdLineAccounts,
} from "./lines.ts";
import type { RawJscpdCloneFile, RawJscpdReport } from "./raw.ts";

export type { JscpdRawTotals } from "./evidence.ts";

/** The normalized product of one validated jscpd report over its accounted selection. */
export interface JscpdNormalizedEvidence {
	/** Pair and group evidence, deterministically ordered; distinct units, never equated. */
	cloneEvidence: readonly CloneEvidence[];
	/** Namespaced metric values (`provider.jscpd.…`), unscored, sorted by id. */
	metrics: readonly MetricValue[];
	/** One namespaced finding per clone evidence entry, in evidence order. */
	findings: readonly Finding[];
	/** Trellis-owned per-source-set line accounts (union semantics). */
	lineAccounting: JscpdLineAccounts;
	/** The provider's own totals, explanation only. */
	rawTotals: JscpdRawTotals;
	/** Records whose two members canonicalize to one location: line-accounted, never evidence. */
	degenerateRecords: number;
}

/** The raw kinds whose matches carry transitive content equivalence (near is not among them). */
const EQUIVALENT_KINDS: ReadonlySet<string> = new Set(["exact", "renamed"]);

/** Canonicalize one reported clone name onto the accounted selection (see the docblock). */
function canonicalPath(name: string, selectionPaths: readonly string[]): string {
	const normalized = name.replaceAll("\\", "/").replace(/^(\.\/)+/, "");
	let best: string | undefined;
	for (const path of selectionPaths) {
		if (path === normalized) {
			return path;
		}
		if (normalized.endsWith(`/${path}`) && (best === undefined || path.length > best.length)) {
			best = path;
		}
	}
	if (best !== undefined) {
		return best;
	}
	throw new InvalidJscpdEvidenceError(
		`clone references "${name}", which does not resolve against the accounted selection`,
	);
}

/** One reported clone side as a contract location (lines as reported, columns 1-based). */
function cloneLocation(side: RawJscpdCloneFile, selectionPaths: readonly string[]): CloneLocation {
	return {
		path: canonicalPath(side.name, selectionPaths),
		range: {
			start: { line: side.start, column: side.startLoc.column + 1 },
			end: { line: side.end, column: side.endLoc.column + 1 },
		},
	};
}

/** Canonicalize every record: both member locations, the raw record retained. */
function canonicalClones(
	report: RawJscpdReport,
	selectionPaths: readonly string[],
): CanonicalClone[] {
	return report.duplicates.map((record) => ({
		first: cloneLocation(record.firstFile, selectionPaths),
		second: cloneLocation(record.secondFile, selectionPaths),
		record,
	}));
}

/**
 * Fragment classes over equivalence-bearing kinds: records of kind
 * `exact`/`renamed` keyed by byte-identical exhibited fragment — the only
 * relation groups are ever built from (a proven content equivalence).
 */
function fragmentClasses(clones: readonly CanonicalClone[]): Map<string, CanonicalClone[]> {
	const classes = new Map<string, CanonicalClone[]>();
	for (const clone of clones) {
		if (!EQUIVALENT_KINDS.has(clone.record.kind)) {
			continue;
		}
		const classRecords = classes.get(clone.record.fragment);
		if (classRecords === undefined) {
			classes.set(clone.record.fragment, [clone]);
		} else {
			classRecords.push(clone);
		}
	}
	return classes;
}

/** Shape every proven multi-record class into its group entry (single-record classes stay pairs). */
function groupEntries(classes: Map<string, CanonicalClone[]>): {
	entries: NormalizedEntry[];
	grouped: ReadonlySet<CanonicalClone>;
} {
	const entries: NormalizedEntry[] = [];
	const grouped = new Set<CanonicalClone>();
	for (const [fragment, classRecords] of [...classes.entries()].sort(([a], [b]) =>
		a < b ? -1 : 1,
	)) {
		if (classRecords.length < 2) {
			continue;
		}
		const entry = groupEntry(fragment, classRecords);
		if (entry.evidence.members.length < 2) {
			continue; // every member collapsed to one location: no group is representable
		}
		entries.push(entry);
		for (const clone of classRecords) {
			grouped.add(clone);
		}
	}
	return { entries, grouped };
}

/** Pair entries for every record a group does not represent; degenerate ones only count. */
function pairEntries(
	clones: readonly CanonicalClone[],
	grouped: ReadonlySet<CanonicalClone>,
): { entries: NormalizedEntry[]; degenerateRecords: number } {
	const entries: NormalizedEntry[] = [];
	let degenerateRecords = 0;
	for (const clone of clones) {
		if (grouped.has(clone)) {
			continue;
		}
		if (compareCloneLocations(clone.first, clone.second) === 0) {
			degenerateRecords += 1;
			continue;
		}
		entries.push(pairEntry(clone));
	}
	return { entries, degenerateRecords };
}

/** Both members of every reported clone as accounting spans (groups included). */
function memberSpansOf(clones: readonly CanonicalClone[]): JscpdCloneMemberSpan[] {
	return clones.flatMap((clone) => [
		{
			path: clone.first.path,
			startLine: clone.first.range.start.line,
			endLine: clone.first.range.end.line,
		},
		{
			path: clone.second.path,
			startLine: clone.second.range.start.line,
			endLine: clone.second.range.end.line,
		},
	]);
}

/**
 * Normalize one validated jscpd report over its accounted selection (see
 * the module docblock for the exact pair/group, canonicalization, and
 * accounting semantics). Deterministic: a reordered raw report over the
 * same selection normalizes to an identical result.
 */
export function normalizeJscpdReport(
	report: RawJscpdReport,
	files: readonly JscpdAccountedFile[],
): JscpdNormalizedEvidence {
	const selectionPaths = files.map((file) => file.path);
	const clones = canonicalClones(report, selectionPaths);
	const classes = fragmentClasses(clones);
	const groups = groupEntries(classes);
	const pairs = pairEntries(clones, groups.grouped);

	const entries = [...groups.entries, ...pairs.entries].sort((a, b) =>
		compareEvidence(a.evidence, b.evidence),
	);
	const evidence = entries.map((entry) => entry.evidence);
	const lineAccounting = accountCloneLines(files, memberSpansOf(clones));

	const pairCount = evidence.filter((entry) => entry.kind === "pair").length;
	const groupCount = evidence.filter((entry) => entry.kind === "group").length;
	const metrics = [
		lineMetric("production", lineAccounting.production),
		lineMetric("test", lineAccounting.test),
		...unitCountMetrics(pairCount, groupCount),
	].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

	return {
		cloneEvidence: evidence,
		metrics,
		findings: entries.map((entry) => entry.finding),
		lineAccounting,
		rawTotals: rawTotalsOf(report),
		degenerateRecords: pairs.degenerateRecords,
	};
}
