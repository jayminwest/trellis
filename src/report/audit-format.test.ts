import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AuditReport, Finding, MetricValue } from "../contract/index.ts";
import { auditFixture, type FixtureReport } from "./audit-fixtures.ts";
import {
	boundFindings,
	coverageRows,
	findingLocation,
	formatLocation,
	formatMetric,
	formatNumber,
	hotspotFindings,
	otherFindings,
	repoLabel,
	scoreHeadline,
	sortedMetrics,
} from "./audit-format.ts";

let clean: FixtureReport;
let sloppy: FixtureReport;
let incomplete: FixtureReport;

beforeAll(async () => {
	clean = await auditFixture("clean");
	sloppy = await auditFixture("sloppy");
	incomplete = await auditFixture("incomplete");
});

afterAll(async () => {
	await Promise.all([clean.cleanup(), sloppy.cleanup(), incomplete.cleanup()]);
});

/** A finding with the fields the helpers read, defaulted. */
function finding(kind: string, path: string, start: number, end = start): Finding {
	return {
		kind,
		path,
		range: { start: { line: start }, end: { line: end } },
		summary: `${kind} summary`,
	};
}

describe("formatNumber", () => {
	test("keeps integers as integers and trims decimals to four places", () => {
		expect(formatNumber(0)).toBe("0");
		expect(formatNumber(42)).toBe("42");
		expect(formatNumber(0.854512)).toBe("0.8545");
		expect(formatNumber(72.993)).toBe("72.993");
		expect(formatNumber(0.031)).toBe("0.031");
	});
});

describe("formatLocation", () => {
	test("renders a bare path without a range", () => {
		expect(formatLocation("src/a.ts")).toBe("src/a.ts");
	});

	test("renders path:line when start and end share a line", () => {
		expect(formatLocation("src/a.ts", { start: { line: 7 }, end: { line: 7 } })).toBe("src/a.ts:7");
	});

	test("renders path:start-end for a multi-line range", () => {
		expect(formatLocation("src/a.ts", { start: { line: 41 }, end: { line: 128 } })).toBe(
			"src/a.ts:41-128",
		);
	});
});

describe("findingLocation", () => {
	test("locates a finding at its relative path and line range", () => {
		expect(findingLocation(finding("complexity.hotspot", "src/build.ts", 41, 128))).toBe(
			"src/build.ts:41-128",
		);
	});
});

describe("formatMetric", () => {
	test("renders a complete metric with its unit and raw pair", () => {
		const metric: MetricValue = {
			id: "duplication.density.production",
			state: "complete",
			value: 0.031,
			unit: "ratio",
			numerator: 412,
			denominator: 13280,
		};
		expect(formatMetric(metric)).toBe("0.031 ratio (412/13280)");
	});

	test("renders a bare count without a unit suffix", () => {
		const metric: MetricValue = {
			id: "import-cycle.groups",
			state: "complete",
			value: 2,
			unit: "count",
		};
		expect(formatMetric(metric)).toBe("2");
	});

	test("renders an incomplete metric with its partial value and reason", () => {
		const metric: MetricValue = {
			id: "graph.edges.unresolved",
			state: "incomplete",
			value: 1,
			unit: "count",
			reason: "1 import(s) could not be resolved",
		};
		expect(formatMetric(metric)).toBe("1 · incomplete — 1 import(s) could not be resolved");
	});

	test("renders an incomplete metric without a value as reason only", () => {
		const metric: MetricValue = {
			id: "complexity.cc.p50.production",
			state: "incomplete",
			unit: "cc",
			reason: "2 production file(s) produced parse diagnostics",
		};
		expect(formatMetric(metric)).toBe(
			"incomplete — 2 production file(s) produced parse diagnostics",
		);
	});

	test("never invents a value for not-applicable or unsupported metrics", () => {
		const na: MetricValue = {
			id: "complexity.cc.p50.production",
			state: "not-applicable",
			unit: "cc",
		};
		const unsupported: MetricValue = {
			id: "complexity.cc.p50.production",
			state: "unsupported",
			unit: "cc",
		};
		expect(formatMetric(na)).toBe("n/a");
		expect(formatMetric(unsupported)).toBe("unsupported");
	});
});

describe("sortedMetrics", () => {
	test("returns the report metrics sorted by id", () => {
		const ids = sortedMetrics(clean.report).map((metric) => metric.id);
		expect(ids).toEqual([...ids].sort());
		expect(ids.length).toBe(Object.keys(clean.report.metrics).length);
	});
});

describe("hotspotFindings / otherFindings", () => {
	test("partitions ranked measurement findings from other located evidence", () => {
		const synthetic: Finding[] = [
			finding("complexity.hotspot", "src/a.ts", 1, 10),
			finding("graph.unresolved-import", "src/b.ts", 2),
			finding("import-cycle", "src/c.ts", 3),
			finding("safeguard.broken-reference", "package.json", 4),
			finding("duplication.clone-group", "src/d.ts", 5, 9),
		];
		const report: AuditReport = { ...clean.report, findings: synthetic };
		expect(hotspotFindings(report).map((f) => f.kind)).toEqual([
			"complexity.hotspot",
			"import-cycle",
			"duplication.clone-group",
		]);
		expect(otherFindings(report).map((f) => f.kind)).toEqual([
			"graph.unresolved-import",
			"safeguard.broken-reference",
		]);
	});

	test("preserves the report's deterministic order within the partition", () => {
		const kinds = hotspotFindings(sloppy.report).map((f) => f.kind);
		expect(kinds).toEqual([...sloppy.report.findings].map((f) => f.kind));
	});
});

describe("boundFindings", () => {
	test("slices to the limit while reporting the full total", () => {
		const findings = sloppy.report.findings;
		const bounded = boundFindings(findings, 1);
		expect(bounded.total).toBe(findings.length);
		expect(bounded.shown).toEqual(findings.slice(0, 1));
	});

	test("shows everything when the limit exceeds the list", () => {
		const bounded = boundFindings(sloppy.report.findings, 100);
		expect(bounded.shown.length).toBe(bounded.total);
	});
});

describe("scoreHeadline", () => {
	test("carries the index, its direction, and the scoring version — never a percentage", () => {
		const headline = scoreHeadline(sloppy.report);
		expect(headline).toBe(
			`sloppiness index ${sloppy.report.score.index}/100 · lower is better · scoring ${sloppy.report.scoringVersion}`,
		);
		expect(headline).not.toContain("%");
	});

	test("flags a partial headline when analysis is missing", () => {
		expect(scoreHeadline(incomplete.report)).toContain(
			"PARTIAL (missing analysis is never zero debt)",
		);
		expect(scoreHeadline(clean.report)).not.toContain("PARTIAL");
	});
});

describe("coverageRows", () => {
	test("omits absent scopes and keeps the contract scope order", () => {
		expect(coverageRows(clean.report.sourceCoverage).map((row) => row.scope)).toEqual([
			"production",
			"test",
		]);
	});

	test("carries sloc and notes when the scope has them", async () => {
		const mixed = await auditFixture("mixed-language");
		try {
			const rows = coverageRows(mixed.report.sourceCoverage);
			expect(rows.map((row) => row.scope)).toEqual(["production", "test", "unsupported"]);
			const unsupported = rows.find((row) => row.scope === "unsupported");
			expect(unsupported).toMatchObject({ files: 2, note: "non-TS sources, not analyzed" });
			expect(rows[0]?.sloc).toBeGreaterThan(0);
		} finally {
			await mixed.cleanup();
		}
	});
});

describe("repoLabel", () => {
	test("prefers the manifest identity and falls back to the root path", () => {
		expect(repoLabel(clean.report)).toBe("fixture-clean");
		const anonymous: AuditReport = { ...clean.report, repo: { root: "/abs/path" } };
		expect(repoLabel(anonymous)).toBe("/abs/path");
	});
});
