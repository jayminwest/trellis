/**
 * Analysis identity and observed-coverage contracts (SPEC §16.2, trellis-90d6).
 *
 * **Analysis identity** is *what the analysis consumed*: the input snapshot
 * (selected source sets and files with content fingerprints — the
 * source-selection semantics), the parser identity that read them (trellis's
 * pinned TypeScript, or the provider's own engine where it differs), and the
 * trellis-owned declarative options in effect. Two analyses are identical
 * only when provider identity (provider.ts) *and* analysis identity both
 * match — see {@link measurementIdentity}, the canonical basis for §16.6
 * evidence compatibility.
 *
 * **Observed coverage** is *what the analysis actually saw*, asserted from
 * the provider's own evidence — never inferred from exit status (§16.2; the
 * spike recorded a successful empty graph). It distinguishes intended files
 * (the selection below) from actually analyzed files, plus diagnostics and
 * unsupported context. Coverage is evidence, never cleanliness.
 *
 * Determinism (AC1): identity fields exclude machine paths, timestamps and
 * durations — those live on {@link executionMetadataSchema}, recorded for
 * operators and never entering {@link measurementIdentity}.
 */
import { z } from "zod";
import { SOURCE_SETS } from "./coverage.ts";
import {
	dottedIdSchema,
	finiteNumberSchema,
	relativePathSchema,
	versionStringSchema,
} from "./primitives.ts";
import { type ProviderIdentity, type ProviderOptions, providerOptionsSchema } from "./provider.ts";

/** Content fingerprint of a selected file — a lowercase sha-256 hex digest. */
export const contentFingerprintSchema = z
	.string()
	.regex(/^[0-9a-f]{64}$/, "must be a lowercase sha-256 hex digest");

/** One selected file: repo-relative path plus content fingerprint. */
export const snapshotFileSchema = z.strictObject({
	path: relativePathSchema,
	fingerprint: contentFingerprintSchema,
});
export type SnapshotFile = z.infer<typeof snapshotFileSchema>;

/** Strictly increasing (unique, deterministically sorted) string values. */
function isSortedUnique(values: readonly string[]): boolean {
	for (let i = 1; i < values.length; i++) {
		const previous = values[i - 1];
		const current = values[i];
		if (previous === undefined || current === undefined || previous >= current) {
			return false;
		}
	}
	return true;
}

/**
 * Source-selection semantics (AC1): which source sets the analysis selected
 * and the exact files (with content fingerprints) that selection resolved
 * to. `files` may be empty (a selected set with no discovered files); paths
 * are unique and sorted so the same selection always has the same identity.
 */
export const sourceSelectionSchema = z
	.strictObject({
		sourceSets: z.array(z.enum(SOURCE_SETS)).min(1),
		files: z.array(snapshotFileSchema),
	})
	.superRefine((selection, ctx) => {
		if (!isSortedUnique(selection.sourceSets)) {
			ctx.addIssue({
				code: "custom",
				message: "source sets must be unique and sorted",
				path: ["sourceSets"],
			});
		}
		if (!isSortedUnique(selection.files.map((file) => file.path))) {
			ctx.addIssue({
				code: "custom",
				message: "selected files must have unique, sorted paths",
				path: ["files"],
			});
		}
	});
export type SourceSelection = z.infer<typeof sourceSelectionSchema>;

/**
 * Parser identity (§16.2): the engine that read the inputs. Native analyses
 * record the pinned shared parse (`trellis.typescript` at the pinned
 * compiler version); a provider whose engine differs records its own
 * (e.g. `jscpd.tokenizer`), so two analyses never compare equal across
 * different parsers.
 */
export const parserIdentitySchema = z.strictObject({
	engine: dottedIdSchema,
	version: versionStringSchema,
});
export type ParserIdentity = z.infer<typeof parserIdentitySchema>;

/**
 * Analysis identity (§16.2): input snapshot, parser identity, and the
 * trellis-owned declarative options in effect. Structurally excludes
 * machine paths, timestamps and durations (AC1) — those are execution
 * metadata only.
 */
export const analysisIdentitySchema = z.strictObject({
	selection: sourceSelectionSchema,
	parser: parserIdentitySchema,
	options: providerOptionsSchema,
});
export type AnalysisIdentity = z.infer<typeof analysisIdentitySchema>;

/**
 * Execution metadata — recorded for operators, never part of measurement
 * identity (§3.5 discipline, AC1). Mirrors `runMetadataSchema` (report.ts):
 * machine paths, timestamps and durations describe the run, not the
 * analysis.
 */
export const executionMetadataSchema = z.strictObject({
	startedAt: z.iso.datetime().optional(),
	durationMs: finiteNumberSchema.nonnegative().optional(),
	machinePath: z.string().min(1).optional(),
	exitCode: z.number().int().optional(),
});
export type ExecutionMetadata = z.infer<typeof executionMetadataSchema>;

/** A diagnostic from an analysis: what went wrong, and where, when known. */
export const analysisDiagnosticSchema = z.strictObject({
	path: relativePathSchema.optional(),
	message: z.string().min(1),
});
export type AnalysisDiagnostic = z.infer<typeof analysisDiagnosticSchema>;

/** Unsupported context the analysis encountered: located, with a reason (never counted as clean). */
export const unsupportedContextSchema = z.strictObject({
	path: relativePathSchema,
	reason: z.string().min(1),
});
export type UnsupportedContext = z.infer<typeof unsupportedContextSchema>;

/**
 * Observed coverage (§16.2, AC2): the files the analysis actually analyzed
 * (a subset of the selection — never inferred from exit status), optionally
 * lines and per-source-set counts, plus diagnostics and unsupported context.
 * Distinguishing intended from analyzed files is what makes "a successful
 * empty run" visible as incomplete rather than clean.
 */
export const observedCoverageSchema = z
	.strictObject({
		analyzedFiles: z.array(relativePathSchema),
		analyzedLines: finiteNumberSchema.int().nonnegative().optional(),
		bySourceSet: z
			.partialRecord(z.enum(SOURCE_SETS), finiteNumberSchema.int().nonnegative())
			.optional(),
		diagnostics: z.array(analysisDiagnosticSchema),
		unsupported: z.array(unsupportedContextSchema),
	})
	.superRefine((coverage, ctx) => {
		if (!isSortedUnique(coverage.analyzedFiles)) {
			ctx.addIssue({
				code: "custom",
				message: "analyzed files must be unique and sorted",
				path: ["analyzedFiles"],
			});
		}
	});
export type ObservedCoverage = z.infer<typeof observedCoverageSchema>;

/** Options with sorted keys, so the same option set always serializes identically. */
function canonicalOptions(options: ProviderOptions): Record<string, string | number | boolean> {
	const sorted: Record<string, string | number | boolean> = {};
	for (const key of Object.keys(options).sort()) {
		const value = options[key];
		if (value !== undefined) {
			sorted[key] = value;
		}
	}
	return sorted;
}

/**
 * The canonical measurement identity of one analysis (§16.2, §16.6): provider
 * identity plus analysis identity, serialized deterministically (sorted
 * option keys, canonical field order). Two analyses are identical only when
 * their `measurementIdentity` strings are equal; execution metadata, machine
 * paths, timestamps and durations are excluded by construction (AC1) and
 * never fragment or merge evidence identities.
 */
export function measurementIdentity(
	provider: ProviderIdentity,
	analysis: AnalysisIdentity,
): string {
	return JSON.stringify({
		provider: {
			kind: provider.kind,
			id: provider.id,
			toolVersion: provider.toolVersion,
			adapterVersion: provider.adapterVersion,
			mode: provider.mode,
			options: canonicalOptions(provider.options),
		},
		analysis: {
			selection: {
				sourceSets: analysis.selection.sourceSets,
				files: analysis.selection.files.map((file) => [file.path, file.fingerprint]),
			},
			parser: analysis.parser,
			options: canonicalOptions(analysis.options),
		},
	});
}
