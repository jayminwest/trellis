import { describe, expect, test } from "bun:test";
import type { JscpdAccountedFile } from "./lines.ts";
import {
	accountedFiles,
	record,
	reportOf,
	spikeReport,
	TOTAL_FUNCTION,
} from "./normalize.fixtures.ts";
import { normalizeJscpdReport } from "./normalize.ts";

describe("normalizeJscpdReport", () => {
	test("canonicalizes path roots, separators, and dot prefixes onto the accounted paths", () => {
		const report = reportOf([
			record({
				first: { name: "./src/a.ts", start: 1, end: 3 },
				second: { name: "src\\b.ts", start: 1, end: 3 },
				kind: "exact",
				fragment: "one",
			}),
			record({
				first: { name: "/tmp/staged-root/src/a.ts", start: 1, end: 3 },
				second: { name: ".//./src/c.ts", start: 1, end: 3 },
				kind: "exact",
				fragment: "two",
			}),
		]);
		const files = accountedFiles({
			"src/a.ts": "export const one = 1;\n",
			"src/b.ts": "export const one = 1;\n",
			"src/c.ts": "export const one = 1;\n",
		});
		const normalized = normalizeJscpdReport(report, files);
		const paths = normalized.cloneEvidence.flatMap((entry) =>
			entry.members.map((member) => member.path),
		);
		expect(paths.every((path) => path.startsWith("src/"))).toBe(true);
		expect(new Set(paths)).toEqual(new Set(["src/a.ts", "src/b.ts", "src/c.ts"]));
	});

	test("resolves a root-prefixed name onto the longest matching accounted path", () => {
		const report = reportOf([
			record({
				first: { name: "/staged/nested/deep/mod.ts", start: 1, end: 3 },
				second: { name: "/staged/shallow/mod.ts", start: 1, end: 3 },
				kind: "exact",
				fragment: "one",
			}),
		]);
		const files = accountedFiles({
			"deep/mod.ts": "export const one = 1;\n",
			"mod.ts": "export const one = 1;\n",
		});
		const normalized = normalizeJscpdReport(report, files);
		// Each root-prefixed name resolves onto its longest matching accounted path,
		// so the two members are distinct locations in deterministic order.
		expect(normalized.cloneEvidence[0]?.members.map((member) => member.path)).toEqual([
			"deep/mod.ts",
			"mod.ts",
		]);
	});

	test("rejects clone references that do not resolve against the accounted selection", () => {
		const report = reportOf([
			record({
				first: { name: "a.ts", start: 1, end: 3 },
				second: { name: "missing.ts", start: 1, end: 3 },
				kind: "exact",
				fragment: "one",
			}),
		]);
		const files = accountedFiles({ "a.ts": TOTAL_FUNCTION, "b.ts": TOTAL_FUNCTION });
		expect(() => normalizeJscpdReport(report, files)).toThrow(
			/does not resolve against the accounted selection/,
		);
	});

	test("normalizes reordered raw reports to an identical result", () => {
		const files = accountedFiles({
			"a.ts": TOTAL_FUNCTION,
			"b.ts": TOTAL_FUNCTION,
			"c.ts": TOTAL_FUNCTION,
		});
		const records = [
			record({
				first: { name: "b.ts", start: 1, end: 14 },
				second: { name: "c.ts", start: 1, end: 14 },
				kind: "exact",
				fragment: TOTAL_FUNCTION,
			}),
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
				fragment: "other",
			}),
		];
		const forward = normalizeJscpdReport(reportOf(records), files);
		const reversed = normalizeJscpdReport(reportOf([...records].reverse()), files);
		expect(forward).toEqual(reversed);
	});

	test("normalizes the pinned tool's reordered corpus report to an identical result", () => {
		const report = spikeReport("production-normalized.json");
		const stub = "export const accounted = 1;\n".repeat(40);
		const names = [
			...new Set(
				report.duplicates.flatMap((clone) => [clone.firstFile.name, clone.secondFile.name]),
			),
		].sort();
		const files: JscpdAccountedFile[] = names.map((path) => ({
			path,
			sourceSet: "production",
			text: stub,
		}));
		const forward = normalizeJscpdReport(report, files);
		const reordered = normalizeJscpdReport(
			{ ...report, duplicates: [...report.duplicates].reverse() },
			files,
		);
		expect(forward).toEqual(reordered);
		expect(forward.cloneEvidence.length).toBeGreaterThan(0);
		expect(forward.lineAccounting.production.affectedCodeLines).toBeGreaterThan(0);
	});
});
