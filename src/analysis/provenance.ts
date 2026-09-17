/**
 * Provenance assembly for native analyzer runs (SPEC §16.2, trellis-cb51).
 *
 * The wrappers in `native.ts` use these helpers to wrap trellis's existing
 * analyzers in the step-2 typed interfaces: the **analysis identity** (what
 * the analysis consumed — the measured source selection with content
 * fingerprints, the pinned shared parser, the trellis-owned options) and the
 * **observed coverage** (what it actually analyzed — asserted from its own
 * evidence, never inferred).
 *
 * Documented state mapping (the §16.2 provider states, kept strictly
 * separate from the native §3.3 metric states): a native analyzer is a pure
 * pass over the one shared syntax inventory, so it always processes exactly
 * its selection — `complete`, with observed coverage asserting that
 * selection. When any selected file produced parse diagnostics, the run is
 * `incomplete` with those diagnostics recorded as its coverage gap; every
 * other native degradation (unresolved imports, duplication budget
 * exhaustion) stays where the native contract already carries it — the
 * metric states inside the same result, which the wrapper never alters.
 *
 * Fingerprints are computed from the shared parse's own text — no re-read,
 * no extra parse (§13 one shared parse). ASTs and internal caches never
 * enter the identity, coverage, or evidence (AC2).
 */
import { createHash } from "node:crypto";
import {
	ANALYZER_VERSION,
	type AnalysisDiagnostic,
	type AnalysisIdentity,
	type ObservedCoverage,
	type ProviderIdentity,
	type ProviderOptions,
	SOURCE_SETS,
	type SourceSelection,
	type SourceSet,
} from "../contract/index.ts";
import type { SyntaxInventory } from "../syntax/index.ts";

/** The source sets the scored analyzers measure (SPEC §3.1 — separately). */
export const MEASURED_SOURCE_SETS = ["production", "test"] as const;

/** Every source set the shared inventory classifies files into. */
export const ALL_SOURCE_SETS: readonly SourceSet[] = SOURCE_SETS;

/** The shared-parse engine identity every native analysis records (§16.2). */
const SHARED_PARSE_ENGINE = "trellis.typescript";

/**
 * The native provider identity of one analyzer: kind `native`, the trellis
 * analyzer version pinned as both tool and adapter version, and the exact
 * mode/option set supplied.
 */
export function nativeAnalyzerIdentity(
	id: string,
	mode: string,
	options: ProviderOptions = {},
): ProviderIdentity {
	return {
		kind: "native",
		id,
		toolVersion: ANALYZER_VERSION,
		adapterVersion: ANALYZER_VERSION,
		mode,
		options,
	};
}

/** The sha-256 content fingerprint of one file's exact text (the evidence unit, §16.2). */
export function contentFingerprint(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** One analyzer's measured scope: its selection plus what the run observed. */
export interface NativeScope {
	/** The input snapshot: intended source sets and the files they resolved to. */
	selection: SourceSelection;
	/** The observed-coverage outcome of a run over exactly that selection. */
	outcome: NativeScopeOutcome;
}

/** The state + observed coverage of one native run over its selection. */
export interface NativeScopeOutcome {
	state: "complete" | "incomplete";
	observedCoverage: ObservedCoverage;
	/** Present only for an `incomplete` run (what could not be analyzed). */
	reason?: string;
}

/**
 * Build one analyzer's measured scope over `sourceSets`: the selection (the
 * sets' files with content fingerprints, sorted) and the coverage a native
 * pass over that selection observes. Files come from the shared inventory in
 * its sorted order; diagnostics of the selected files are the run's coverage
 * gap (the documented state mapping above).
 */
export function nativeScope(
	inventory: SyntaxInventory,
	sourceSets: readonly SourceSet[],
): NativeScope {
	const sets = new Set(sourceSets);
	const files = inventory.files.filter((file) => sets.has(file.sourceSet));
	const diagnostics: AnalysisDiagnostic[] = files.flatMap((file) =>
		file.diagnostics.map((diagnostic) => ({ path: file.path, message: diagnostic.message })),
	);
	const bySourceSet: Partial<Record<SourceSet, number>> = {};
	for (const file of files) {
		bySourceSet[file.sourceSet] = (bySourceSet[file.sourceSet] ?? 0) + 1;
	}
	const selection: SourceSelection = {
		sourceSets: [...sourceSets].sort(),
		files: files
			.map((file) => ({
				path: file.path,
				fingerprint: contentFingerprint(file.sourceFile.text),
			}))
			.sort((a, b) => (a.path < b.path ? -1 : 1)),
	};
	const diagnosticFiles = new Set(
		files.filter((file) => file.diagnostics.length > 0).map((file) => file.path),
	);
	const outcome: NativeScopeOutcome =
		diagnostics.length === 0
			? {
					state: "complete",
					observedCoverage: {
						analyzedFiles: selection.files.map((file) => file.path),
						bySourceSet,
						diagnostics: [],
						unsupported: [],
					},
				}
			: {
					state: "incomplete",
					reason: `${diagnosticFiles.size} selected file(s) produced parse diagnostics; metric values are partial`,
					observedCoverage: {
						analyzedFiles: selection.files.map((file) => file.path),
						bySourceSet,
						diagnostics,
						unsupported: [],
					},
				};
	return { selection, outcome };
}

/** The analysis identity of a native run: selection, shared parser, options. */
export function nativeAnalysisIdentity(
	scope: NativeScope,
	compilerVersion: string,
	options: ProviderOptions = {},
): AnalysisIdentity {
	return {
		selection: scope.selection,
		parser: { engine: SHARED_PARSE_ENGINE, version: compilerVersion },
		options,
	};
}
