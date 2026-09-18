import { describe, expect, test } from "bun:test";
import type { KnipProviderRequest } from "../../contract/index.ts";
import type { StagedSelectionFile } from "../staging.ts";
import { prepareReachabilityContext } from "./context.ts";
import { normalizeKnipReport } from "./normalize.ts";
import { compileReachabilityPolicy } from "./policy.ts";
import { type RawKnipReport, rawKnipReportSchema } from "./raw.ts";

/**
 * Normalization of validated knip observations (plan `pl-43c5` step 24 —
 * trellis-8ebc): the four candidate categories normalize into their own
 * namespaced kinds with the tool's own positions, declared public surfaces
 * exempt matching candidates as visible evidence (never silently dropped,
 * never unresolved imports), candidate counts never claim defects, and a
 * reordered raw report normalizes to a byte-identical result (the research
 * record's nondeterministic row ordering).
 */

/** The selection the prepared context resolves against. */
const SELECTION: StagedSelectionFile[] = [
	{ path: "src/main.ts", sourceSet: "production", packagePath: "." },
	{ path: "src/pub.ts", sourceSet: "production", packagePath: "." },
	{ path: "src/other.ts", sourceSet: "production", packagePath: "." },
];

/** The declared model: one entry, a file-level surface and a named surface. */
const REQUEST: KnipProviderRequest = {
	entries: ["src/main.ts"],
	public: [{ path: "src/pub.ts" }, { path: "src/other.ts", export: "kept" }],
};

/** A raw report exercising every category and every exemption rule. */
function rawReport(order: "sorted" | "reversed" = "sorted"): RawKnipReport {
	const rows = [
		{
			file: "src/pub.ts",
			exports: [{ name: "pubAll", line: 2, col: 14, pos: 30 }],
			files: [{ name: "src/pub.ts" }],
			types: [{ name: "PubType", line: 3, col: 13, pos: 60 }],
			unresolved: [{ name: "./unresolved-in-pub.ts", line: 4, col: 8, pos: 80 }],
		},
		{
			file: "src/other.ts",
			exports: [
				{ name: "kept", line: 2, col: 14, pos: 36 },
				{ name: "dropped", line: 3, col: 14, pos: 50 },
			],
			files: [{ name: "src/other.ts" }],
			types: [{ name: "kept", line: 4, col: 13, pos: 64 }],
			unresolved: [],
		},
		{
			file: "src/main.ts",
			exports: [
				{ name: "mainUnused", line: 5, col: 14, pos: 90 },
				{ name: "member", namespace: "Nested", line: 7, col: 14, pos: 110 },
			],
			files: [],
			types: [],
			unresolved: [{ name: "./missing.ts", line: 6, col: 8, pos: 100 }],
		},
	];
	return rawKnipReportSchema.parse({
		issues: order === "sorted" ? rows : [...rows].reverse(),
	});
}

/** The normalized evidence of the fixture report. */
function normalized(order: "sorted" | "reversed" = "sorted") {
	const context = prepareReachabilityContext(compileReachabilityPolicy(REQUEST), SELECTION);
	return normalizeKnipReport(rawReport(order), context);
}

describe("normalizeKnipReport candidates", () => {
	test("keeps the four categories apart with their own kinds, paths and positions", () => {
		const evidence = normalized();
		const standing = evidence.candidates.map((candidate) =>
			[candidate.category, candidate.path, candidate.symbol ?? ""].join(":"),
		);
		expect(standing).toEqual([
			"unresolved:src/main.ts:./missing.ts",
			"export:src/main.ts:mainUnused",
			"export:src/main.ts:member",
			"export:src/other.ts:dropped",
			"unresolved:src/pub.ts:./unresolved-in-pub.ts",
		]);
		const kinds = new Set(evidence.findings.map((finding) => finding.kind));
		expect([...kinds].sort()).toEqual([
			"provider.knip.public-surface",
			"provider.knip.unresolved-import",
			"provider.knip.unused-export",
		]);
		const unresolved = evidence.findings.find(
			(finding) => finding.kind === "provider.knip.unresolved-import",
		);
		expect(unresolved?.range).toEqual({
			start: { line: 6, column: 8 },
			end: { line: 6, column: 8 },
		});
		// A namespace member keeps its parent namespace in its facts — the
		// tool's own located record, never flattened away.
		const member = evidence.findings.find(
			(finding) =>
				finding.kind === "provider.knip.unused-export" &&
				finding.facts !== undefined &&
				finding.facts.symbol === "member",
		);
		expect(member?.facts).toMatchObject({ symbol: "member", namespace: "Nested" });
	});

	test("normalizes a reordered raw report to a byte-identical result", () => {
		expect(JSON.stringify(normalized("reversed"))).toBe(JSON.stringify(normalized("sorted")));
	});
});

describe("normalizeKnipReport public-surface exemptions", () => {
	test("a file-level surface exempts its file, exports and types as visible evidence", () => {
		const evidence = normalized();
		const pubExemptions = evidence.exemptions.filter((exemption) =>
			exemption.surface.startsWith("src/pub.ts"),
		);
		expect(pubExemptions.map((exemption) => exemption.category)).toEqual([
			"export",
			"file",
			"type",
		]);
		for (const exemption of pubExemptions) {
			expect(exemption.surface).toBe("src/pub.ts");
		}
		const findings = evidence.findings.filter(
			(finding) => finding.kind === "provider.knip.public-surface",
		);
		expect(findings).toHaveLength(6);
		for (const finding of findings) {
			expect(finding.summary).toContain("declared public surface");
			expect(finding.summary).toContain("never silently dropped");
		}
	});

	test("a named surface exempts its named export and the hosting file, not the rest", () => {
		const evidence = normalized();
		const otherExemptions = evidence.exemptions.filter(
			(exemption) => exemption.surface === "src/other.ts#kept",
		);
		expect(otherExemptions.map((exemption) => exemption.category)).toEqual([
			"export",
			"file",
			"type",
		]);
		// The un-named export stays a candidate — a surface narrows, never widens.
		expect(
			evidence.candidates.some(
				(candidate) => candidate.path === "src/other.ts" && candidate.symbol === "dropped",
			),
		).toBe(true);
	});

	test("never exempts an unresolved import: a surface declares exported API, not import health", () => {
		const evidence = normalized();
		expect(
			evidence.candidates.some(
				(candidate) => candidate.path === "src/pub.ts" && candidate.category === "unresolved",
			),
		).toBe(true);
		expect(evidence.exemptions.some((exemption) => exemption.category === "unresolved")).toBe(
			false,
		);
	});
});

describe("normalizeKnipReport metrics and assumptions", () => {
	test("counts standing candidates, exemptions and recorded assumptions, never defects", () => {
		const evidence = normalized();
		const byId = new Map(evidence.metrics.map((metric) => [metric.id, metric.value]));
		expect([...byId.keys()].sort()).toEqual([...byId.keys()].sort());
		expect(byId.get("provider.knip.candidates.exports")).toBe(3);
		expect(byId.get("provider.knip.candidates.types")).toBe(0);
		expect(byId.get("provider.knip.candidates.unresolved")).toBe(2);
		expect(byId.get("provider.knip.candidates.files")).toBe(0);
		expect(byId.get("provider.knip.candidates.total")).toBe(5);
		expect(byId.get("provider.knip.exemptions.public-surfaces")).toBe(6);
		const assumptions = evidence.metrics.find(
			(metric) => metric.id === "provider.knip.context.assumptions",
		);
		expect(assumptions?.detail).toMatchObject({
			ids: ["dependency-context-unverified", "plugin-discovery-disabled"],
		});
		const scope = evidence.metrics.find((metric) => metric.id === "provider.knip.scope.files");
		expect(scope?.value).toBe(3);
		expect(scope?.detail).toMatchObject({ entryRoots: 1, testRoots: 0, projectFiles: 3 });
		for (const metric of evidence.metrics) {
			expect(metric.state).toBe("complete");
			expect(metric.unit).toBe("count");
		}
	});

	test("carries the prepared context's assumptions unchanged", () => {
		const context = prepareReachabilityContext(compileReachabilityPolicy(REQUEST), SELECTION);
		const evidence = normalizeKnipReport(rawReport(), context);
		expect(evidence.assumptions.map((assumption) => assumption.id)).toEqual(
			context.assumptions.map((assumption) => assumption.id),
		);
	});
});
