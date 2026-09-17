/**
 * Shared fixtures for the analysis-result contract tests (trellis-90d6).
 *
 * Typed literals (compile-checked against the contract types); the tests
 * themselves exercise the runtime schemas. Mirrors the spike evidence
 * shapes: an external jscpd-style duplication provider and a native
 * trellis duplication analyzer over the same two-file selection.
 */
import type { AnalysisIdentity, ObservedCoverage } from "./analysis.ts";
import type { CloneEvidence } from "./clone-evidence.ts";
import type { Finding } from "./finding.ts";
import type { MetricValue } from "./metric.ts";
import type { ProviderIdentity } from "./provider.ts";

const fingerprint = (char: string): string => char.repeat(64);

export const externalProvider: ProviderIdentity = {
	kind: "external",
	id: "jscpd",
	toolVersion: "5.2.1",
	adapterVersion: "0.2.1",
	mode: "token",
	options: { "ignore-identifiers": true },
};

export const nativeProvider: ProviderIdentity = {
	kind: "native",
	id: "trellis.duplication",
	toolVersion: "0.2.1",
	adapterVersion: "0.2.1",
	mode: "shared-parse",
	options: {},
};

export const fullAnalysis: AnalysisIdentity = {
	selection: {
		sourceSets: ["production"],
		files: [
			{ path: "src/a.ts", fingerprint: fingerprint("a") },
			{ path: "src/b.ts", fingerprint: fingerprint("b") },
		],
	},
	parser: { engine: "jscpd.tokenizer", version: "5.2.1" },
	options: { "min-tokens": 50 },
};

export const fullCoverage: ObservedCoverage = {
	analyzedFiles: ["src/a.ts", "src/b.ts"],
	analyzedLines: 220,
	bySourceSet: { production: 2 },
	diagnostics: [],
	unsupported: [],
};

export const partialCoverage: ObservedCoverage = {
	analyzedFiles: ["src/a.ts"],
	analyzedLines: 110,
	diagnostics: [{ path: "src/b.ts", message: "typescript parser unavailable" }],
	unsupported: [],
};

export const emptyCoverage: ObservedCoverage = {
	analyzedFiles: [],
	analyzedLines: 0,
	diagnostics: [],
	unsupported: [],
};

export const externalPair: CloneEvidence = {
	kind: "pair",
	matchMode: "normalized",
	members: [
		{ path: "src/a.ts", range: { start: { line: 3 }, end: { line: 17 } } },
		{ path: "src/b.ts", range: { start: { line: 5 }, end: { line: 19 } } },
	],
};

export const externalMetric: MetricValue = {
	id: "provider.jscpd.pairs",
	state: "complete",
	value: 1,
	unit: "count",
};

export const externalFinding: Finding = {
	kind: "provider.jscpd.clone-pair",
	path: "src/a.ts",
	range: { start: { line: 3 }, end: { line: 17 } },
	summary: "normalized clone pair with src/b.ts:5",
};
