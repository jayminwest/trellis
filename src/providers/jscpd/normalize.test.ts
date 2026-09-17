import { describe, expect, test } from "bun:test";
import type { CloneLocation } from "../../contract/index.ts";
import { cloneEvidenceSchema, findingSchema, metricValueSchema } from "../../contract/index.ts";
import type { JscpdAccountedFile } from "./lines.ts";
import {
	accountedFiles,
	fixtureTexts,
	record,
	reportOf,
	spikeReport,
	TOTAL_FUNCTION,
} from "./normalize.fixtures.ts";
import { normalizeJscpdReport } from "./normalize.ts";

/** The identical 14-line pair, both members production. */
const PAIR_FILES = accountedFiles({ "a.ts": TOTAL_FUNCTION, "b.ts": TOTAL_FUNCTION });

describe("normalizeJscpdReport", () => {
	/** The expected contract location of a whole-file 1–14 span (1-based columns). */
	function at(path: string): CloneLocation {
		return { path, range: { start: { line: 1, column: 1 }, end: { line: 14, column: 2 } } };
	}

	test("accounts identical 14-line files as 28 affected code lines, not the tool's percentage", () => {
		const normalized = normalizeJscpdReport(spikeReport("exact-exact.json"), PAIR_FILES);
		expect(normalized.cloneEvidence).toEqual([
			{ kind: "pair", matchMode: "exact", members: [at("a.ts"), at("b.ts")] },
		]);
		expect(normalized.lineAccounting.production).toEqual({
			files: 2,
			codeLines: 28,
			affectedCodeLines: 28,
		});
		expect(
			normalized.metrics.find(
				(metric) => metric.id === "provider.jscpd.duplication.affected-code-lines.production",
			),
		).toMatchObject({ state: "complete", value: 28, numerator: 28, denominator: 28 });
		// The provider's own totals stay explanation-only evidence, never the metric.
		expect(normalized.rawTotals.total.percentage).toBeCloseTo(46.428571428571431);
		expect(normalized.rawTotals.total.duplicatedLines).toBe(13);
		expect("detectionDate" in normalized.rawTotals).toBe(false);
	});

	test("keeps renamed-literal matches as normalized pairs without inventing groups", () => {
		const normalized = normalizeJscpdReport(
			spikeReport("renamed-normalized.json"),
			accountedFiles(fixtureTexts("renamed")),
		);
		expect(normalized.cloneEvidence).toHaveLength(1);
		expect(normalized.cloneEvidence[0]).toMatchObject({ kind: "pair", matchMode: "normalized" });
		expect(normalized.lineAccounting.production.affectedCodeLines).toBe(28);
		expect(
			normalized.metrics.find((metric) => metric.id === "provider.jscpd.duplication.clone-groups"),
		).toMatchObject({ value: 0 });
	});

	test("keeps near-match evidence pair-only with its method and similarity preserved", () => {
		const files = accountedFiles(fixtureTexts("near"));
		const normalized = normalizeJscpdReport(spikeReport("near-near.json"), files);
		expect(normalized.cloneEvidence).toHaveLength(1);
		expect(normalized.cloneEvidence[0]).toMatchObject({ kind: "pair", matchMode: "near" });
		expect(normalized.findings[0]?.facts).toMatchObject({
			rawKind: "similar",
			method: "ast",
			similarity: 0.867,
		});
		// a spans 14 code lines, b spans 15 (the inserted log line) — union per file.
		expect(normalized.lineAccounting.production.affectedCodeLines).toBe(29);
		expect(
			normalized.metrics.find((metric) => metric.id === "provider.jscpd.duplication.clone-groups"),
		).toMatchObject({ value: 0 });
	});

	test("forms one proven group for three copies sharing exhibited identical content", () => {
		const files = accountedFiles({
			"a.ts": TOTAL_FUNCTION,
			"b.ts": TOTAL_FUNCTION,
			"c.ts": TOTAL_FUNCTION,
		});
		const report = reportOf([
			record({
				first: { name: "a.ts", start: 1, end: 14 },
				second: { name: "b.ts", start: 1, end: 14 },
				kind: "exact",
				fragment: TOTAL_FUNCTION,
			}),
			record({
				first: { name: "a.ts", start: 1, end: 14 },
				second: { name: "c.ts", start: 1, end: 14 },
				kind: "exact",
				fragment: TOTAL_FUNCTION,
			}),
		]);
		const normalized = normalizeJscpdReport(report, files);
		expect(normalized.cloneEvidence).toEqual([
			{
				kind: "group",
				matchMode: "exact",
				members: ["a.ts", "b.ts", "c.ts"].map((path) => ({
					path,
					range: { start: { line: 1, column: 1 }, end: { line: 14, column: 2 } },
				})),
			},
		]);
		expect(normalized.lineAccounting.production).toEqual({
			files: 3,
			codeLines: 42,
			affectedCodeLines: 42,
		});
		expect(normalized.metrics.map((metric) => [metric.id, metric.value])).toEqual([
			["provider.jscpd.duplication.affected-code-lines.production", 42],
			["provider.jscpd.duplication.affected-code-lines.test", 0],
			["provider.jscpd.duplication.clone-groups", 1],
			["provider.jscpd.duplication.clone-pairs", 0],
		]);
		expect(normalized.findings).toEqual([
			{
				kind: "provider.jscpd.clone-group",
				path: "a.ts",
				range: { start: { line: 1, column: 1 }, end: { line: 14, column: 2 } },
				summary: "jscpd exact clone group: 3 locations of identical content",
				facts: {
					matchMode: "exact",
					memberCount: 3,
					rawKinds: ["exact"],
					contentLines: 14,
					members: ["a.ts", "b.ts", "c.ts"].map((path) => ({
						path,
						range: { start: { line: 1, column: 1 }, end: { line: 14, column: 2 } },
					})),
				},
			},
		]);
	});

	test("never merges near matches into groups by transitivity", () => {
		const files = accountedFiles({
			"a.ts": TOTAL_FUNCTION,
			"b.ts": TOTAL_FUNCTION.replace("item > limit", "item >= limit"),
			"c.ts": TOTAL_FUNCTION.replace("item * 2", "item * 3"),
		});
		// Both similar records exhibit the same first-file content: a alone proves
		// nothing about b versus c, so no group may span them (nontransitive similarity).
		const report = reportOf([
			record({
				first: { name: "a.ts", start: 1, end: 14 },
				second: { name: "b.ts", start: 1, end: 15 },
				kind: "similar",
				fragment: TOTAL_FUNCTION,
				similarity: 0.86,
			}),
			record({
				first: { name: "a.ts", start: 1, end: 14 },
				second: { name: "c.ts", start: 1, end: 15 },
				kind: "similar",
				fragment: TOTAL_FUNCTION,
				similarity: 0.86,
			}),
		]);
		const normalized = normalizeJscpdReport(report, files);
		expect(normalized.cloneEvidence).toHaveLength(2);
		expect(normalized.cloneEvidence.every((entry) => entry.kind === "pair")).toBe(true);
		expect(
			normalized.metrics.find((metric) => metric.id === "provider.jscpd.duplication.clone-groups"),
		).toMatchObject({ value: 0 });
		expect(
			normalized.metrics.find((metric) => metric.id === "provider.jscpd.duplication.clone-pairs"),
		).toMatchObject({ value: 2 });
	});

	test("grades a mixed-kind fragment class at the weakest proven match mode", () => {
		const files = accountedFiles({
			"a.ts": TOTAL_FUNCTION,
			"b.ts": TOTAL_FUNCTION,
			"c.ts": TOTAL_FUNCTION.replace("total", "sum"),
		});
		const report = reportOf([
			record({
				first: { name: "a.ts", start: 1, end: 14 },
				second: { name: "b.ts", start: 1, end: 14 },
				kind: "exact",
				fragment: TOTAL_FUNCTION,
			}),
			record({
				first: { name: "a.ts", start: 1, end: 14 },
				second: { name: "c.ts", start: 1, end: 14 },
				kind: "renamed",
				fragment: TOTAL_FUNCTION,
			}),
		]);
		const normalized = normalizeJscpdReport(report, files);
		expect(normalized.cloneEvidence).toEqual([
			{
				kind: "group",
				matchMode: "normalized",
				members: ["a.ts", "b.ts", "c.ts"].map((path) => ({
					path,
					range: { start: { line: 1, column: 1 }, end: { line: 14, column: 2 } },
				})),
			},
		]);
		expect(normalized.findings[0]?.facts).toMatchObject({
			matchMode: "normalized",
			rawKinds: ["exact", "renamed"],
		});
	});

	test("unions overlapping clone members once per file", () => {
		const long = `export const value = ${"1;\nexport const other = 2;\n".repeat(10)}1;\n`;
		const files = accountedFiles({ "x.ts": long, "y.ts": long, "z.ts": long });
		const report = reportOf([
			record({
				first: { name: "x.ts", start: 1, end: 14 },
				second: { name: "y.ts", start: 1, end: 14 },
				kind: "exact",
				fragment: "one",
			}),
			record({
				first: { name: "x.ts", start: 5, end: 18 },
				second: { name: "z.ts", start: 5, end: 18 },
				kind: "exact",
				fragment: "two",
			}),
		]);
		const normalized = normalizeJscpdReport(report, files);
		expect(
			normalized.metrics.find((metric) => metric.id === "provider.jscpd.duplication.clone-pairs"),
		).toMatchObject({ value: 2 });
		// x's covered union is lines 1-18 (not 14 + 14); y and z each cover 14.
		expect(normalized.lineAccounting.production.affectedCodeLines).toBe(18 + 14 + 14);
	});

	test("keeps degenerate self-matched records visible without inventing evidence", () => {
		const report = reportOf([
			record({
				first: { name: "a.ts", start: 1, end: 14 },
				second: { name: "a.ts", start: 1, end: 14 },
				kind: "exact",
				fragment: TOTAL_FUNCTION,
			}),
		]);
		const normalized = normalizeJscpdReport(report, PAIR_FILES);
		expect(normalized.cloneEvidence).toEqual([]);
		expect(normalized.degenerateRecords).toBe(1);
		expect(
			normalized.metrics.find((metric) => metric.id === "provider.jscpd.duplication.clone-pairs"),
		).toMatchObject({ value: 0 });
		// The degenerate record's lines still count, once per file.
		expect(normalized.lineAccounting.production.affectedCodeLines).toBe(14);
		expect(normalized.rawTotals.total.clones).toBe(1);
	});

	test("deduplicates repeated identical records into their proven group", () => {
		const report = reportOf([
			record({
				first: { name: "a.ts", start: 1, end: 14 },
				second: { name: "b.ts", start: 1, end: 14 },
				kind: "exact",
				fragment: TOTAL_FUNCTION,
			}),
			record({
				first: { name: "a.ts", start: 1, end: 14 },
				second: { name: "b.ts", start: 1, end: 14 },
				kind: "exact",
				fragment: TOTAL_FUNCTION,
			}),
		]);
		const normalized = normalizeJscpdReport(report, PAIR_FILES);
		expect(normalized.cloneEvidence).toHaveLength(1);
		expect(normalized.cloneEvidence[0]).toMatchObject({ kind: "group", matchMode: "exact" });
		expect(normalized.cloneEvidence[0]?.members).toHaveLength(2);
		expect(normalized.lineAccounting.production.affectedCodeLines).toBe(28);
	});

	test("separates production and test line accounting across a cross-set pair", () => {
		const files: JscpdAccountedFile[] = [
			{ path: "src/a.ts", sourceSet: "production", text: TOTAL_FUNCTION },
			{ path: "src/a.test.ts", sourceSet: "test", text: TOTAL_FUNCTION },
		];
		const report = reportOf([
			record({
				first: { name: "src/a.ts", start: 1, end: 14 },
				second: { name: "src/a.test.ts", start: 1, end: 14 },
				kind: "exact",
				fragment: TOTAL_FUNCTION,
			}),
		]);
		const normalized = normalizeJscpdReport(report, files);
		expect(normalized.lineAccounting).toEqual({
			production: { files: 1, codeLines: 14, affectedCodeLines: 14 },
			test: { files: 1, codeLines: 14, affectedCodeLines: 14 },
		});
		expect(
			normalized.metrics.find(
				(metric) => metric.id === "provider.jscpd.duplication.affected-code-lines.test",
			),
		).toMatchObject({ value: 14, numerator: 14, denominator: 14 });
	});

	test("emits schema-valid namespaced contract evidence with both units preserved", () => {
		const files = accountedFiles({
			"a.ts": TOTAL_FUNCTION,
			"b.ts": TOTAL_FUNCTION,
			"c.ts": TOTAL_FUNCTION,
		});
		const report = reportOf([
			record({
				first: { name: "a.ts", start: 1, end: 14 },
				second: { name: "b.ts", start: 1, end: 14 },
				kind: "exact",
				fragment: TOTAL_FUNCTION,
			}),
			record({
				first: { name: "a.ts", start: 1, end: 14 },
				second: { name: "c.ts", start: 1, end: 14 },
				kind: "exact",
				fragment: TOTAL_FUNCTION,
			}),
			record({
				first: { name: "b.ts", start: 1, end: 14 },
				second: { name: "c.ts", start: 1, end: 15 },
				kind: "similar",
				fragment: "near",
				similarity: 0.87,
			}),
		]);
		const normalized = normalizeJscpdReport(report, files);
		for (const entry of normalized.cloneEvidence) {
			expect(cloneEvidenceSchema.safeParse(entry).success).toBe(true);
		}
		for (const finding of normalized.findings) {
			expect(findingSchema.safeParse(finding).success).toBe(true);
			expect(finding.kind.startsWith("provider.jscpd.")).toBe(true);
		}
		const ids = normalized.metrics.map((metric) => metric.id);
		expect(ids).toEqual([...ids].sort());
		for (const metric of normalized.metrics) {
			expect(metricValueSchema.safeParse(metric).success).toBe(true);
			expect(metric.id.startsWith("provider.jscpd.")).toBe(true);
		}
		// The proven group and the near pair are distinct units, both preserved.
		expect(normalized.cloneEvidence.map((entry) => [entry.kind, entry.matchMode])).toEqual([
			["group", "exact"],
			["pair", "near"],
		]);
	});
});
