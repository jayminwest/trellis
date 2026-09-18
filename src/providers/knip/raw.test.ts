import { describe, expect, test } from "bun:test";
import {
	KNIP_ADAPTER_VERSION,
	KNIP_CANDIDATE_CATEGORIES,
	KNIP_INCLUDE,
	KNIP_MODE,
	KNIP_PARSER_ENGINE,
	KNIP_PROVIDER_ID,
	parseRawKnipReport,
	type RawKnipReport,
	rawKnipReportSchema,
	validateRawKnipEvidence,
} from "./raw.ts";

/**
 * Raw Knip report schemas and validation (plan `pl-43c5` step 24 —
 * trellis-8ebc): the pinned reporter's exact payload parses into typed
 * evidence, malformed or foreign payloads fail with located bounded
 * reasons, and validation catches records outside the staged selection,
 * orphan records that are not their row's own file, repeated rows and
 * repeated symbols — suspect evidence, never findings.
 */

const SELECTION = new Set(["src/main.ts", "src/live.ts"]);

/** A well-formed two-row report (the pinned reporter's exact shape). */
function report(): RawKnipReport {
	return rawKnipReportSchema.parse({
		issues: [
			{
				file: "src/live.ts",
				exports: [
					{ name: "unused", line: 2, col: 14, pos: 36 },
					{ name: "member", namespace: "Nested", line: 3, col: 12, pos: 48 },
				],
				files: [],
				types: [],
				unresolved: [],
			},
			{
				file: "src/main.ts",
				exports: [],
				files: [{ name: "src/main.ts" }],
				types: [{ name: "Unused", line: 3, col: 13, pos: 60 }],
				unresolved: [{ name: "./missing.ts", line: 5, col: 8, pos: 132 }],
			},
		],
	});
}

describe("parseRawKnipReport", () => {
	test("parses the pinned reporter's exact payload into typed evidence", () => {
		const parsed = parseRawKnipReport(JSON.stringify(report()));
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) throw new Error("expected the report to parse");
		expect(parsed.report.issues).toHaveLength(2);
		expect(parsed.report.issues[0]?.exports[0]?.name).toBe("unused");
	});

	test("rejects malformed JSON with a located reason", () => {
		const parsed = parseRawKnipReport('{"issues": [');
		expect(parsed.ok).toBe(false);
		if (parsed.ok) throw new Error("expected the report to fail");
		expect(parsed.reasons[0]).toContain("not valid JSON");
	});

	test("rejects unknown payloads and foreign categories with bounded reasons", () => {
		for (const text of [
			"null",
			"{}",
			JSON.stringify({ issues: [{ file: "src/main.ts", exports: [] }] }),
			JSON.stringify({
				issues: [
					{
						file: "src/main.ts",
						exports: [],
						files: [],
						types: [],
						unresolved: [],
						dependencies: [],
					},
				],
			}),
		]) {
			const parsed = parseRawKnipReport(text);
			expect(parsed.ok).toBe(false);
			if (parsed.ok) throw new Error("expected the report to fail");
			expect(parsed.reasons.length).toBeGreaterThan(0);
			expect(parsed.reasons.length).toBeLessThanOrEqual(8);
		}
	});

	test("rejects candidate records without a well-formed position", () => {
		const parsed = parseRawKnipReport(
			JSON.stringify({
				issues: [
					{
						file: "src/main.ts",
						exports: [{ name: "unused", line: 0, col: 1, pos: 0 }],
						files: [],
						types: [],
						unresolved: [],
					},
				],
			}),
		);
		expect(parsed.ok).toBe(false);
	});
});

describe("validateRawKnipEvidence", () => {
	test("accepts a report whose records stay inside the staged selection", () => {
		expect(validateRawKnipEvidence(report(), SELECTION)).toEqual([]);
	});

	test("flags a row outside the staged selection as suspect evidence", () => {
		const flagged = validateRawKnipEvidence(report(), new Set(["src/main.ts"]));
		expect(flagged[0]).toContain("outside the staged selection");
	});

	test("flags an orphan record that is not its row's own file", () => {
		const raw = rawKnipReportSchema.parse({
			issues: [
				{
					file: "src/main.ts",
					exports: [],
					files: [{ name: "src/live.ts" }],
					types: [],
					unresolved: [],
				},
			],
		});
		expect(validateRawKnipEvidence(raw, SELECTION)).toEqual([
			expect.stringContaining("not the row's own file"),
		]);
	});

	test("flags repeated rows and repeated symbol records", () => {
		const row = {
			file: "src/main.ts",
			exports: [
				{ name: "unused", line: 2, col: 14, pos: 36 },
				{ name: "unused", line: 2, col: 14, pos: 36 },
			],
			files: [],
			types: [],
			unresolved: [],
		};
		const repeatedRow = rawKnipReportSchema.parse({ issues: [row, row] });
		const reasons = validateRawKnipEvidence(repeatedRow, SELECTION);
		expect(reasons.some((reason) => reason.includes("repeats file"))).toBe(true);
		expect(reasons.some((reason) => reason.includes("twice"))).toBe(true);
	});

	test("caps its reasons so diagnostics never become firehoses", () => {
		const rows = Array.from({ length: 12 }, (_, index) => ({
			file: `src/outside-${index}.ts`,
			exports: [],
			files: [],
			types: [],
			unresolved: [],
		}));
		const raw = rawKnipReportSchema.parse({ issues: rows });
		const reasons = validateRawKnipEvidence(raw, SELECTION);
		expect(reasons).toHaveLength(9);
		expect(reasons[8]).toContain("…and 4 more problems");
	});
});

describe("knip provider identity constants", () => {
	test("pins the provider id, adapter version, mode, parser and include set", () => {
		expect(KNIP_PROVIDER_ID).toBe("knip");
		expect(KNIP_ADAPTER_VERSION).toBe("0.1.0");
		expect(KNIP_MODE).toBe("contextual");
		expect(KNIP_PARSER_ENGINE).toBe("knip.oxc-parser");
		expect(KNIP_INCLUDE).toBe("files,exports,types,unresolved");
		expect(KNIP_CANDIDATE_CATEGORIES).toEqual(["file", "export", "type", "unresolved"]);
	});
});
