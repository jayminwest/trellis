/**
 * Normalization of validated Knip observations into stable, namespaced,
 * **unscored** reachability evidence (SPEC §16.5, plan `pl-43c5` step 24 —
 * trellis-8ebc).
 *
 * Input: one schema-validated raw report (`./raw.ts`) plus the prepared
 * reachability context (`./context.ts`, step 23). Output: contract findings
 * and metrics, namespaced `provider.knip.*` — advisory evidence, never
 * scoring inputs, never displacing the native analyzers. Pure: no process,
 * no filesystem, no audit wiring (`./analysis.ts` owns the fold).
 *
 * **Exact semantics (plan risk 6 — every candidate is contextual):**
 *
 * - **Candidates, never defects.** Each orphan file, unused export, unused
 *   type and unresolved import becomes one finding of its own kind with the
 *   tool's own located position. Candidate counts are never confirmed dead
 *   code and never score contributions; the recorded contextual
 *   assumptions ride along as visible identity.
 * - **Declared public surfaces are visible exemptions.** A surface
 *   (file-level or narrowed to one named export) exempts the matching
 *   orphan-file/export/type candidates at the declared file — recorded as
 *   `provider.knip.public-surface` findings with the exempting surface,
 *   never silently dropped (the tool never saw the declaration). Unresolved
 *   imports are never exempted: a surface declares exported API, not
 *   import health.
 * - **A barrel re-export is the barrel's surface.** The exemption applies
 *   at the declared file's path only; the implementation files a barrel
 *   exposes remain ordinary project files whose own unused exports stay
 *   candidates (AC5) — and entry-file exports are never candidates at all
 *   (the tool's own entry semantics).
 * - **Deterministic.** The tool's row order is nondeterministic between
 *   repeat runs (the research record); every normalized collection is
 *   sorted — candidates by path, then symbol, then category, then position
 *   — so repeat runs normalize byte-identically.
 */
import type { Finding, MetricValue } from "../../contract/index.ts";
import { namespacedEvidenceId } from "../../contract/index.ts";
import type { PreparedReachabilityContext } from "./context.ts";
import type { ReachabilityAssumption } from "./policy.ts";
import type { KnipCandidateCategory, RawKnipReport, RawKnipSymbol } from "./raw.ts";
import { KNIP_PROVIDER_ID } from "./raw.ts";

/** One normalized reachability candidate — contextual, never a defect. */
export interface NormalizedCandidate {
	/** The declared candidate category (the tool's own four). */
	category: KnipCandidateCategory;
	/** The repo-relative file the tool located the candidate at. */
	path: string;
	/** The export/type name or the unresolved specifier; absent for orphan files. */
	symbol?: string;
	/** The parent namespace the tool reported the member inside, when it did. */
	namespace?: string;
	/** The tool's own 1-based position; absent for orphan files. */
	line?: number;
	column?: number;
}

/** One candidate exempted by a declared public surface — visible, never silently dropped. */
export interface PublicSurfaceExemption {
	/** The declared surface (`src/index.ts` or `src/index.ts#export`). */
	surface: string;
	/** The exempted candidate's category. */
	category: KnipCandidateCategory;
	/** The exempted candidate's file. */
	path: string;
	/** The exempted candidate's symbol; absent for orphan files. */
	symbol?: string;
}

/** The normalized product of one validated reachability pass. */
export interface KnipNormalizedEvidence {
	/** Namespaced metric values (`provider.knip.…`), unscored, sorted by id. */
	metrics: readonly MetricValue[];
	/** One namespaced finding per candidate and per exemption, deterministically ordered. */
	findings: readonly Finding[];
	/** The standing candidates (post-exemption), deterministically ordered. */
	candidates: readonly NormalizedCandidate[];
	/** The exemptions declared public surfaces produced, deterministically ordered. */
	exemptions: readonly PublicSurfaceExemption[];
	/** The contextual assumptions behind every candidate (from the prepared context, sorted). */
	assumptions: readonly ReachabilityAssumption[];
}

/** The file-level range an orphan-file candidate carries (the tool reports no position). */
const FILE_RANGE = { start: { line: 1 }, end: { line: 1 } } as const;

/** The total candidate order: path, then symbol, then category, then position (AC on stable ordering). */
function byCandidate(a: NormalizedCandidate, b: NormalizedCandidate): number {
	if (a.path !== b.path) return a.path < b.path ? -1 : 1;
	const aSymbol = a.symbol ?? "";
	const bSymbol = b.symbol ?? "";
	if (aSymbol !== bSymbol) return aSymbol < bSymbol ? -1 : 1;
	if (a.category !== b.category) return a.category < b.category ? -1 : 1;
	return (a.line ?? 0) - (b.line ?? 0);
}

/** The total exemption order: surface, then candidate path, category, symbol. */
function byExemption(a: PublicSurfaceExemption, b: PublicSurfaceExemption): number {
	if (a.surface !== b.surface) return a.surface < b.surface ? -1 : 1;
	if (a.path !== b.path) return a.path < b.path ? -1 : 1;
	if (a.category !== b.category) return a.category < b.category ? -1 : 1;
	return (a.symbol ?? "") < (b.symbol ?? "") ? -1 : 1;
}

/** The deterministic finding order: path, then kind, then summary. */
function byFinding(a: Finding, b: Finding): number {
	if (a.path !== b.path) return a.path < b.path ? -1 : 1;
	if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
	return a.summary < b.summary ? -1 : 1;
}

/** Extract every candidate record from a validated raw report (unsorted, unfiltered). */
function candidatesOf(report: RawKnipReport): NormalizedCandidate[] {
	const candidates: NormalizedCandidate[] = [];
	for (const row of report.issues) {
		if (row.files.length > 0) candidates.push({ category: "file", path: row.file });
		const located = (category: KnipCandidateCategory, records: readonly RawKnipSymbol[]) => {
			for (const record of records) {
				candidates.push({
					category,
					path: row.file,
					symbol: record.name,
					...(record.namespace === undefined ? {} : { namespace: record.namespace }),
					line: record.line,
					column: record.col,
				});
			}
		};
		located("export", row.exports);
		located("type", row.types);
		located("unresolved", row.unresolved);
	}
	return candidates;
}

/** Whether one declared public surface exempts one candidate (see the module docblock). */
function exemptingSurface(
	context: PreparedReachabilityContext,
	candidate: NormalizedCandidate,
): string | undefined {
	for (const surface of context.publicSurfaces) {
		if (surface.path !== candidate.path) continue;
		const isFileCandidate = candidate.category === "file";
		const isSymbolCandidate = candidate.category === "export" || candidate.category === "type";
		if (surface.export === undefined) {
			// A file-level surface: the file is public by declaration, so its
			// orphan-file, export and type candidates are all exempted; an
			// unresolved import is never an exported-API question.
			if (isFileCandidate || isSymbolCandidate) return surface.path;
			continue;
		}
		// A named surface: the file hosts a public export, so the orphan-file
		// candidate is exempt, and the named export/type candidate is exempt.
		if (isFileCandidate) return `${surface.path}#${surface.export}`;
		if (isSymbolCandidate && candidate.symbol === surface.export) {
			return `${surface.path}#${surface.export}`;
		}
	}
	return undefined;
}

/** Split candidates into standing candidates and visible public-surface exemptions. */
function applyPublicSurfaces(
	context: PreparedReachabilityContext,
	candidates: readonly NormalizedCandidate[],
): { standing: NormalizedCandidate[]; exemptions: PublicSurfaceExemption[] } {
	const standing: NormalizedCandidate[] = [];
	const exemptions: PublicSurfaceExemption[] = [];
	for (const candidate of candidates) {
		const surface = exemptingSurface(context, candidate);
		if (surface === undefined) {
			standing.push(candidate);
			continue;
		}
		exemptions.push({
			surface,
			category: candidate.category,
			path: candidate.path,
			...(candidate.symbol === undefined ? {} : { symbol: candidate.symbol }),
		});
	}
	standing.sort(byCandidate);
	exemptions.sort(byExemption);
	return { standing, exemptions };
}

/** The namespaced finding kind of one candidate category. */
function candidateKind(category: KnipCandidateCategory): string {
	return namespacedEvidenceId(
		KNIP_PROVIDER_ID,
		category === "unresolved" ? "unresolved-import" : `unused-${category}`,
	);
}

/** The tool-reported position of one candidate, as a point range (file candidates carry none). */
function candidateRange(candidate: NormalizedCandidate) {
	return {
		range: {
			start: { line: candidate.line ?? 1, column: candidate.column ?? 1 },
			end: { line: candidate.line ?? 1, column: candidate.column ?? 1 },
		},
		locatedFacts:
			candidate.line === undefined || candidate.symbol === undefined
				? {}
				: { line: candidate.line, column: candidate.column, symbol: candidate.symbol },
	};
}

/** The ` at <path>:<line>:<col>` suffix a located candidate carries. */
function candidateAt(candidate: NormalizedCandidate): string {
	if (candidate.line === undefined) return "";
	return ` at ${candidate.path}:${candidate.line}:${candidate.column ?? 1}`;
}

/** One finding for an orphan-file candidate. */
function fileCandidateFinding(candidate: NormalizedCandidate): Finding {
	return {
		kind: candidateKind(candidate.category),
		path: candidate.path,
		range: FILE_RANGE,
		summary:
			`unreferenced file candidate '${candidate.path}' — contextual: no declared root or ` +
			"re-export reaches it, never confirmed dead code",
		facts: { category: candidate.category },
	};
}

/** One finding for an unresolved-import candidate. */
function unresolvedCandidateFinding(candidate: NormalizedCandidate): Finding {
	const { range, locatedFacts } = candidateRange(candidate);
	return {
		kind: candidateKind(candidate.category),
		path: candidate.path,
		range,
		summary:
			`unresolved import '${candidate.symbol}'${candidateAt(candidate)} — the specifier resolved ` +
			"to no staged file (unverified dependency context: a recorded assumption, never a defect)",
		facts: { category: candidate.category, specifier: candidate.symbol ?? "", ...locatedFacts },
	};
}

/** One finding for an unused-export or unused-type candidate. */
function symbolCandidateFinding(candidate: NormalizedCandidate): Finding {
	const { range, locatedFacts } = candidateRange(candidate);
	return {
		kind: candidateKind(candidate.category),
		path: candidate.path,
		range,
		summary:
			`unused ${candidate.category} candidate '${candidate.symbol}'${candidateAt(candidate)} — ` +
			"contextual over the declared reachability model, never confirmed dead code",
		facts: {
			category: candidate.category,
			...(candidate.namespace === undefined ? {} : { namespace: candidate.namespace }),
			...locatedFacts,
		},
	};
}

/** One finding for a standing candidate — contextual, never a defect. */
function candidateFinding(candidate: NormalizedCandidate): Finding {
	if (candidate.category === "file") return fileCandidateFinding(candidate);
	if (candidate.category === "unresolved") return unresolvedCandidateFinding(candidate);
	return symbolCandidateFinding(candidate);
}

/** One finding for a candidate exempted by a declared public surface. */
function exemptionFinding(exemption: PublicSurfaceExemption): Finding {
	return {
		kind: namespacedEvidenceId(KNIP_PROVIDER_ID, "public-surface"),
		path: exemption.path,
		range: FILE_RANGE,
		summary:
			`declared public surface '${exemption.surface}' exempts the ${exemption.category} candidate` +
			`${exemption.symbol === undefined ? "" : ` '${exemption.symbol}'`} — a visible exception ` +
			"from the declared reachability model, never silently dropped",
		facts: {
			surface: exemption.surface,
			category: exemption.category,
			...(exemption.symbol === undefined ? {} : { symbol: exemption.symbol }),
		},
	};
}

/** Count one metric by name with a complete value and optional detail. */
function countMetric(name: string, value: number, detail?: Record<string, unknown>): MetricValue {
	return {
		id: namespacedEvidenceId(KNIP_PROVIDER_ID, name),
		state: "complete",
		value,
		unit: "count",
		...(detail === undefined ? {} : { detail }),
	};
}

/** The namespaced metric set of one normalized pass (see the module docblock). */
function normalizedMetrics(
	context: PreparedReachabilityContext,
	standing: readonly NormalizedCandidate[],
	exemptions: readonly PublicSurfaceExemption[],
): MetricValue[] {
	const byCategory: Record<KnipCandidateCategory, number> = {
		file: 0,
		export: 0,
		type: 0,
		unresolved: 0,
	};
	for (const candidate of standing) {
		byCategory[candidate.category] += 1;
	}
	const assumptionIds = [...new Set(context.assumptions.map((assumption) => assumption.id))].sort();
	const scope = new Set([...context.entryRoots, ...context.testRoots, ...context.projectFiles]);
	return [
		countMetric("candidates.files", byCategory.file),
		countMetric("candidates.exports", byCategory.export),
		countMetric("candidates.types", byCategory.type),
		countMetric("candidates.unresolved", byCategory.unresolved),
		countMetric("candidates.total", standing.length),
		countMetric("exemptions.public-surfaces", exemptions.length),
		countMetric("context.assumptions", context.assumptions.length, { ids: assumptionIds }),
		countMetric("scope.files", scope.size, {
			entryRoots: context.entryRoots.length,
			testRoots: context.testRoots.length,
			projectFiles: context.projectFiles.length,
		}),
	].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Normalize one validated raw report against the prepared reachability
 * context it evaluated (see the module docblock for the exact candidate,
 * exemption and assumption semantics). Deterministic: a reordered raw report
 * over the same context normalizes to an identical result.
 */
export function normalizeKnipReport(
	report: RawKnipReport,
	context: PreparedReachabilityContext,
): KnipNormalizedEvidence {
	const { standing, exemptions } = applyPublicSurfaces(context, candidatesOf(report));
	const findings: Finding[] = [
		...standing.map(candidateFinding),
		...exemptions.map(exemptionFinding),
	].sort(byFinding);
	return {
		metrics: normalizedMetrics(context, standing, exemptions),
		findings,
		candidates: standing,
		exemptions,
		assumptions: [...context.assumptions],
	};
}
