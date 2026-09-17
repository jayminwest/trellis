import { describe, expect, test } from "bun:test";
import {
	type AnalysisDiagnostic,
	type AnalysisIdentity,
	analysisDiagnosticSchema,
	analysisIdentitySchema,
	contentFingerprintSchema,
	type ExecutionMetadata,
	executionMetadataSchema,
	measurementIdentity,
	type ObservedCoverage,
	observedCoverageSchema,
	type ParserIdentity,
	parserIdentitySchema,
	type SourceSelection,
	sourceSelectionSchema,
	type UnsupportedContext,
	unsupportedContextSchema,
} from "./analysis.ts";
import { type ProviderIdentity, providerIdentitySchema } from "./provider.ts";

const fingerprint = (char: "a" | "b" | "c"): string => char.repeat(64);

const externalProvider: ProviderIdentity = {
	kind: "external",
	id: "jscpd",
	toolVersion: "5.2.1",
	adapterVersion: "0.2.1",
	mode: "token",
	options: { "ignore-identifiers": true },
};

const parser: ParserIdentity = { engine: "jscpd.tokenizer", version: "5.2.1" };

const selection: SourceSelection = {
	sourceSets: ["production"],
	files: [
		{ path: "src/a.ts", fingerprint: fingerprint("a") },
		{ path: "src/b.ts", fingerprint: fingerprint("b") },
	],
};

const identity: AnalysisIdentity = { selection, parser, options: { "min-tokens": 50 } };

const coverage: ObservedCoverage = {
	analyzedFiles: ["src/a.ts", "src/b.ts"],
	analyzedLines: 220,
	bySourceSet: { production: 2 },
	diagnostics: [],
	unsupported: [],
};

describe("contentFingerprintSchema", () => {
	test("accepts a 64-character lowercase sha-256 digest", () => {
		expect(contentFingerprintSchema.parse(fingerprint("a"))).toBe(fingerprint("a"));
	});

	test("rejects uppercase, short, and non-hex digests", () => {
		expect(contentFingerprintSchema.safeParse("A".repeat(64)).success).toBe(false);
		expect(contentFingerprintSchema.safeParse("a".repeat(63)).success).toBe(false);
		expect(contentFingerprintSchema.safeParse("z".repeat(64)).success).toBe(false);
	});
});

describe("sourceSelectionSchema", () => {
	test("round-trips a sorted, unique selection", () => {
		expect(sourceSelectionSchema.parse(selection)).toEqual(selection);
	});

	test("accepts an empty file list for a selected set", () => {
		const parsed = sourceSelectionSchema.parse({ sourceSets: ["production"], files: [] });
		expect(parsed.files).toEqual([]);
	});

	test("rejects unsorted or duplicated source sets and an empty set list", () => {
		expect(
			sourceSelectionSchema.safeParse({ ...selection, sourceSets: ["test", "production"] }).success,
		).toBe(false);
		expect(
			sourceSelectionSchema.safeParse({ ...selection, sourceSets: ["production", "production"] })
				.success,
		).toBe(false);
		expect(sourceSelectionSchema.safeParse({ ...selection, sourceSets: [] }).success).toBe(false);
	});

	test("rejects unsorted or duplicated selected files", () => {
		expect(
			sourceSelectionSchema.safeParse({
				...selection,
				files: [selection.files[1], selection.files[0]],
			}).success,
		).toBe(false);
		expect(
			sourceSelectionSchema.safeParse({
				...selection,
				files: [selection.files[0], selection.files[0]],
			}).success,
		).toBe(false);
	});
});

describe("parserIdentitySchema", () => {
	test("round-trips an engine and version", () => {
		expect(parserIdentitySchema.parse(parser)).toEqual(parser);
		expect(
			parserIdentitySchema.safeParse({ engine: "trellis.typescript", version: "6.0.3" }).success,
		).toBe(true);
	});

	test("rejects malformed engines and versions", () => {
		expect(parserIdentitySchema.safeParse({ engine: "Typescript", version: "6.0.3" }).success).toBe(
			false,
		);
		expect(parserIdentitySchema.safeParse({ engine: "typescript", version: "6" }).success).toBe(
			false,
		);
	});
});

describe("analysisIdentitySchema", () => {
	test("round-trips selection, parser, and trellis-owned options", () => {
		expect(analysisIdentitySchema.parse(identity)).toEqual(identity);
	});

	test("structurally rejects execution-only fields (machine paths, timestamps, durations)", () => {
		expect(analysisIdentitySchema.safeParse({ ...identity, durationMs: 120 }).success).toBe(false);
		expect(analysisIdentitySchema.safeParse({ ...identity, machinePath: "/tmp" }).success).toBe(
			false,
		);
		expect(
			analysisIdentitySchema.safeParse({ ...identity, startedAt: "2026-01-01T00:00:00Z" }).success,
		).toBe(false);
	});
});

describe("executionMetadataSchema", () => {
	test("accepts the run-only fields operators need", () => {
		const execution: ExecutionMetadata = {
			startedAt: "2026-01-01T00:00:00Z",
			durationMs: 35,
			machinePath: "/private/var/folders/scratch",
			exitCode: 0,
		};
		expect(executionMetadataSchema.parse(execution)).toEqual(execution);
	});

	test("rejects unknown keys and negative durations", () => {
		expect(executionMetadataSchema.safeParse({ durationMs: -1 }).success).toBe(false);
		expect(executionMetadataSchema.safeParse({ exitStatus: 0 }).success).toBe(false);
	});
});

describe("analysisDiagnosticSchema", () => {
	test("accepts a message with and without a location", () => {
		const diagnostic: AnalysisDiagnostic = { message: "typescript parser unavailable" };
		expect(analysisDiagnosticSchema.parse(diagnostic)).toEqual(diagnostic);
		expect(analysisDiagnosticSchema.parse({ path: "src/b.ts", message: "parse error" })).toEqual({
			path: "src/b.ts",
			message: "parse error",
		});
	});

	test("rejects empty messages and absolute paths", () => {
		expect(analysisDiagnosticSchema.safeParse({ message: "" }).success).toBe(false);
		expect(analysisDiagnosticSchema.safeParse({ path: "/abs/b.ts", message: "x" }).success).toBe(
			false,
		);
	});
});

describe("unsupportedContextSchema", () => {
	test("accepts located, reasoned context and rejects bare entries", () => {
		const context: UnsupportedContext = { path: "src/legacy.ts", reason: "outside the parser set" };
		expect(unsupportedContextSchema.parse(context)).toEqual(context);
		expect(unsupportedContextSchema.safeParse({ path: "src/legacy.ts" }).success).toBe(false);
	});
});

describe("observedCoverageSchema", () => {
	test("round-trips asserted coverage with per-source-set counts", () => {
		expect(observedCoverageSchema.parse(coverage)).toEqual(coverage);
	});

	test("rejects unsorted or duplicated analyzed files", () => {
		expect(
			observedCoverageSchema.safeParse({ ...coverage, analyzedFiles: ["src/b.ts", "src/a.ts"] })
				.success,
		).toBe(false);
		expect(
			observedCoverageSchema.safeParse({ ...coverage, analyzedFiles: ["src/a.ts", "src/a.ts"] })
				.success,
		).toBe(false);
	});

	test("rejects negative lines and counts", () => {
		expect(observedCoverageSchema.safeParse({ ...coverage, analyzedLines: -1 }).success).toBe(
			false,
		);
		expect(
			observedCoverageSchema.safeParse({ ...coverage, bySourceSet: { production: -2 } }).success,
		).toBe(false);
	});
});

describe("measurementIdentity", () => {
	test("is equal for identical provider and analysis identities", () => {
		expect(measurementIdentity(externalProvider, identity)).toBe(
			measurementIdentity(
				providerIdentitySchema.parse(externalProvider),
				analysisIdentitySchema.parse(identity),
			),
		);
	});

	test("sorts option keys so option order never changes the identity", () => {
		const reorderedProvider = providerIdentitySchema.parse({
			...externalProvider,
			options: { "max-gap-lines": 2, "ignore-identifiers": true },
		});
		expect(measurementIdentity(reorderedProvider, identity)).toBe(
			measurementIdentity(
				providerIdentitySchema.parse({
					...externalProvider,
					options: { "ignore-identifiers": true, "max-gap-lines": 2 },
				}),
				identity,
			),
		);
	});

	test("differs when any identity-bearing part changes", () => {
		const base = measurementIdentity(externalProvider, identity);
		expect(
			measurementIdentity(
				providerIdentitySchema.parse({ ...externalProvider, mode: "literal" }),
				identity,
			),
		).not.toBe(base);
		expect(
			measurementIdentity(
				providerIdentitySchema.parse({ ...externalProvider, toolVersion: "5.2.2" }),
				identity,
			),
		).not.toBe(base);
		expect(
			measurementIdentity(externalProvider, {
				...identity,
				parser: { ...parser, version: "5.2.2" },
			}),
		).not.toBe(base);
		expect(
			measurementIdentity(externalProvider, {
				...identity,
				selection: { ...selection, files: [selection.files[0] ?? { path: "", fingerprint: "" }] },
			}),
		).not.toBe(base);
		expect(measurementIdentity(externalProvider, { ...identity, options: {} })).not.toBe(base);
	});
});
