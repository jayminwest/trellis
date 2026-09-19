import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	MATCH_MODE_BY_RAW_KIND,
	parseRawJscpdReport,
	type RawJscpdClone,
	type RawJscpdReport,
	validateRawJscpdEvidence,
} from "./raw.ts";

/** Real raw reports from the pinned tool (the research-spike artifacts). */
const SPIKE = join(import.meta.dir, "../../../docs/research/jscpd-provider-spike");

function spikeArtifact(name: string): string {
	return readFileSync(join(SPIKE, name), "utf8");
}

function parsedSpike(name: string): RawJscpdReport {
	const parsed = parseRawJscpdReport(spikeArtifact(name));
	if (!parsed.ok) {
		throw new Error(`spike artifact ${name} should parse: ${parsed.reasons.join("; ")}`);
	}
	return parsed.report;
}

/** The first clone of a spike report (the fixtures always carry one). */
function firstClone(report: RawJscpdReport): RawJscpdClone {
	const clone = report.duplicates[0];
	if (clone === undefined) {
		throw new Error("expected the fixture to carry a duplicate");
	}
	return clone;
}

/** A minimal selection the spike fixtures report against. */
const PAIR_SELECTION = new Set(["a.ts", "b.ts"]);

describe("parseRawJscpdReport", () => {
	test("accepts the pinned tool's raw reports with their exact shapes", () => {
		const exact = parsedSpike("exact-exact.json");
		expect(exact.duplicates).toHaveLength(1);
		expect(firstClone(exact).kind).toBe("exact");
		expect(exact.statistics.total.clones).toBe(1);
		expect(exact.statistics.total.sources).toBe(2);
		const near = parsedSpike("near-near.json");
		expect(firstClone(near).kind).toBe("similar");
		expect(firstClone(near).method).toBe("ast");
		expect(firstClone(near).similarity).toBeGreaterThanOrEqual(0.85);
		expect(MATCH_MODE_BY_RAW_KIND[firstClone(near).kind]).toBe("near");
		expect(MATCH_MODE_BY_RAW_KIND.renamed).toBe("normalized");
	});

	test("rejects malformed JSON with a located reason", () => {
		const parsed = parseRawJscpdReport("{ not json");
		expect(parsed.ok).toBe(false);
		expect(parsed.ok === false && parsed.reasons[0]).toContain("not valid JSON");
	});

	test("rejects truncated report JSON", () => {
		const truncated = spikeArtifact("exact-exact.json").slice(0, 240);
		const parsed = parseRawJscpdReport(truncated);
		expect(parsed.ok).toBe(false);
		expect(parsed.ok === false && parsed.reasons.join("; ")).toContain("not valid JSON");
	});

	test("rejects unknown clone kinds and unknown payload fields", () => {
		const unknownKind = spikeArtifact("exact-exact.json").replace('"exact"', '"typed"');
		const parsed = parseRawJscpdReport(unknownKind);
		expect(parsed.ok).toBe(false);
		expect(parsed.ok === false && parsed.reasons.join("; ")).toContain("kind");
		const withExtra = spikeArtifact("exact-exact.json").replace(
			'"tokens": 88',
			'"tokens": 88, "surprise": true',
		);
		const extra = parseRawJscpdReport(withExtra);
		expect(extra.ok).toBe(false);
		expect(extra.ok === false && extra.reasons.join("; ")).toContain("surprise");
	});

	test("rejects near-miss fields on non-similar clones and their absence on similar", () => {
		const exactWithSimilarity = spikeArtifact("exact-exact.json").replace(
			'"kind": "exact",',
			'"kind": "exact", "similarity": 0.9,',
		);
		expect(parseRawJscpdReport(exactWithSimilarity).ok).toBe(false);
		const similarWithoutFields = spikeArtifact("near-near.json").replace(
			/"similarity": 0.867,/,
			"",
		);
		expect(parseRawJscpdReport(similarWithoutFields).ok).toBe(false);
	});

	test("rejects positions that disagree with their reported line spans", () => {
		const mismatched = spikeArtifact("exact-exact.json").replace('"start": 1,', '"start": 2,');
		const parsed = parseRawJscpdReport(mismatched);
		expect(parsed.ok).toBe(false);
		expect(parsed.ok === false && parsed.reasons.join("; ")).toContain("start line");
	});

	test("rejects statistics that do not account for the listed duplicates", () => {
		const inconsistent = spikeArtifact("exact-exact.json").replaceAll(
			'"clones": 1,',
			'"clones": 2,',
		);
		const parsed = parseRawJscpdReport(inconsistent);
		expect(parsed.ok).toBe(false);
		expect(parsed.ok === false && parsed.reasons.join("; ")).toContain("reported duplicates");
	});
});

describe("validateRawJscpdEvidence", () => {
	test("accepts the spike evidence against its own selection for each mode", () => {
		expect(
			validateRawJscpdEvidence(parsedSpike("exact-exact.json"), PAIR_SELECTION, "exact"),
		).toEqual([]);
		expect(
			validateRawJscpdEvidence(
				parsedSpike("renamed-normalized.json"),
				PAIR_SELECTION,
				"normalized",
			),
		).toEqual([]);
		expect(validateRawJscpdEvidence(parsedSpike("near-near.json"), PAIR_SELECTION, "near")).toEqual(
			[],
		);
	});

	test("flags clone paths outside the staged selection as suspect evidence", () => {
		const report = parsedSpike("exact-exact.json");
		firstClone(report).secondFile.name = "outside/b.ts";
		const reasons = validateRawJscpdEvidence(report, PAIR_SELECTION, "exact");
		expect(reasons.join("; ")).toContain("outside the staged selection");
		expect(reasons.join("; ")).toContain("outside/b.ts");
	});

	test("normalizes backslash-separated clone paths before checking membership", () => {
		const report = parsedSpike("exact-exact.json");
		firstClone(report).firstFile.name = "src\\a.ts";
		firstClone(report).secondFile.name = "src\\b.ts";
		const reasons = validateRawJscpdEvidence(report, new Set(["src/a.ts", "src/b.ts"]), "exact");
		expect(reasons).toEqual([]);
	});

	test("flags match kinds the invocation mode never produces in the pinned tool", () => {
		const renamed = parsedSpike("renamed-normalized.json");
		expect(validateRawJscpdEvidence(renamed, PAIR_SELECTION, "exact").join("; ")).toContain(
			"never produces",
		);
		const similar = parsedSpike("near-near.json");
		expect(validateRawJscpdEvidence(similar, PAIR_SELECTION, "normalized").join("; ")).toContain(
			"never produces",
		);
		expect(validateRawJscpdEvidence(similar, PAIR_SELECTION, "near")).toEqual([]);
	});

	test("flags source statistics claiming more sources than staged files", () => {
		const report = parsedSpike("exact-exact.json");
		report.statistics.total.sources = 5;
		expect(validateRawJscpdEvidence(report, PAIR_SELECTION, "exact").join("; ")).toContain(
			"exceeds the staged selection",
		);
	});

	test("bounds the reported reasons", () => {
		const report = parsedSpike("renamed-normalized.json");
		report.duplicates = Array.from({ length: 10 }, () => structuredClone(firstClone(report)));
		const reasons = validateRawJscpdEvidence(report, new Set(["scripts/x.ts"]), "exact");
		expect(reasons.length).toBeLessThanOrEqual(9);
		expect(reasons[reasons.length - 1]).toMatch(/…and \d+ more problems/);
	});
});
