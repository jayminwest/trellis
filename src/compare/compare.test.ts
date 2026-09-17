import { describe, expect, test } from "bun:test";
import {
	type AuditConfig,
	type AuditReport,
	auditConfigSchema,
	type Finding,
	type MetricValue,
} from "../contract/index.ts";
import { compareFindings, compareMetrics, compareReports } from "./compare.ts";

function metric(id: string, value: number): MetricValue {
	return { id, state: "complete", value, unit: "ratio" };
}

function finding(kind: string, path: string, line: number): Finding {
	return {
		kind,
		path,
		range: { start: { line }, end: { line: line + 9 } },
		summary: `${kind} at ${path}:${line}`,
	};
}

/** A minimal but fully valid §6.4 report; tests mutate the fields they exercise. */
function baseReport(): AuditReport {
	return {
		schemaVersion: "1.0.0",
		analyzerVersion: "0.2.0",
		scoringVersion: "0.1.0-provisional",
		repo: { root: "/abs/path" },
		sourceCoverage: {
			production: { files: 10, sloc: 500 },
			test: { files: 4, sloc: 120 },
		},
		completeness: "complete",
		metrics: {
			"duplication.density": metric("duplication.density", 0.03),
			"import-cycle.groups": {
				id: "import-cycle.groups",
				state: "complete",
				value: 1,
				unit: "count",
			},
		},
		score: {
			index: 20,
			direction: "lower-is-better",
			partial: false,
			contributions: [
				{ dimension: "duplication", points: 12, metricIds: ["duplication.density"] },
				{ dimension: "import-cycle", points: 8, metricIds: ["import-cycle.groups"] },
			],
		},
		findings: [finding("complexity.hotspot", "src/a.ts", 10)],
		safeguards: [],
	};
}

function config(source: Partial<AuditConfig["source"]> = {}): AuditConfig {
	return auditConfigSchema.parse({ source });
}

describe("compareReports", () => {
	test("computes score, metric, and finding deltas for compatible reports", () => {
		const baseline = baseReport();
		const current = baseReport();
		current.score.index = 27;
		const density = current.metrics["duplication.density"];
		if (density === undefined) throw new Error("density metric missing");
		density.value = 0.05;
		current.findings = [
			finding("complexity.hotspot", "src/a.ts", 10),
			finding("import-cycle", "src/cyc-a.ts", 1),
		];
		const comparison = compareReports(baseline, current);
		expect(comparison.compatibility).toEqual({
			comparable: true,
			issues: [],
			caveats: [
				{
					code: "configuration-unverifiable",
					message:
						"audit configurations were not supplied: configuration compatibility could not be verified",
				},
			],
		});
		expect(comparison.score).toEqual({ baseline: 20, current: 27, delta: 7 });
		expect(comparison.findings?.new.map((f) => f.kind)).toEqual(["import-cycle"]);
		expect(comparison.findings?.persistent).toHaveLength(1);
		const deltas = comparison.metrics ?? [];
		expect(deltas.find((d) => d.id === "duplication.density")?.delta).toBeCloseTo(0.02);
		expect(deltas.find((d) => d.id === "import-cycle.groups")?.delta).toBe(0);
	});

	test("refuses version mismatches explicitly and computes no deltas", () => {
		for (const [key, code] of [
			["schemaVersion", "schema-version"],
			["analyzerVersion", "analyzer-version"],
			["scoringVersion", "scoring-version"],
		] as const) {
			const baseline = baseReport();
			const current = { ...baseReport(), [key]: "9.9.9" };
			const comparison = compareReports(baseline, current);
			expect(comparison.compatibility.comparable).toBe(false);
			expect(comparison.compatibility.issues.map((issue) => issue.code)).toEqual([code]);
			expect(comparison.score).toBeUndefined();
			expect(comparison.metrics).toBeUndefined();
			expect(comparison.findings).toBeUndefined();
		}
	});

	test("refuses reports whose metric catalogs differ", () => {
		const baseline = baseReport();
		const current = baseReport();
		const { "import-cycle.groups": _dropped, ...metrics } = current.metrics;
		current.metrics = metrics;
		current.score.contributions = current.score.contributions.filter(
			(c) => c.dimension !== "import-cycle",
		);
		const comparison = compareReports(baseline, current);
		expect(comparison.compatibility.comparable).toBe(false);
		expect(comparison.compatibility.issues.map((issue) => issue.code)).toContain("metric-set");
	});

	test("treats changed exclusions as a configuration incompatibility when configs are supplied", () => {
		const baseline = baseReport();
		const current = baseReport();
		const comparison = compareReports(baseline, current, {
			baselineConfig: config(),
			currentConfig: config({ exclude: ["src/generated/**"] }),
		});
		expect(comparison.compatibility.comparable).toBe(false);
		expect(comparison.compatibility.issues.map((issue) => issue.code)).toContain("configuration");
	});

	test("treats changed classification as a configuration incompatibility", () => {
		const comparison = compareReports(baseReport(), baseReport(), {
			baselineConfig: config(),
			currentConfig: config({ classify: { "scripts/**": "test" } }),
		});
		expect(comparison.compatibility.issues.map((issue) => issue.code)).toContain("configuration");
	});

	test("accepts equivalent configurations supplied in different exclusion order", () => {
		const comparison = compareReports(baseReport(), baseReport(), {
			baselineConfig: config({ exclude: ["b/**", "a/**"] }),
			currentConfig: config({ exclude: ["a/**", "b/**"] }),
		});
		expect(comparison.compatibility.comparable).toBe(true);
		expect(comparison.compatibility.caveats).toEqual([]);
	});

	test("flags changed source scope as an explicit caveat, not a refusal", () => {
		const baseline = baseReport();
		const current = baseReport();
		current.sourceCoverage = {
			...current.sourceCoverage,
			production: { files: 12, sloc: 560 },
			excluded: { files: 3 },
		};
		const comparison = compareReports(baseline, current);
		expect(comparison.compatibility.comparable).toBe(true);
		expect(comparison.compatibility.caveats.map((c) => c.code)).toContain("source-scope-changed");
		expect(comparison.score).toBeDefined();
	});

	test("compares incomplete reports by state, without inventing values", () => {
		const baseline = baseReport();
		const current = baseReport();
		current.completeness = "incomplete";
		current.score.partial = true;
		current.metrics["import-cycle.groups"] = {
			id: "import-cycle.groups",
			state: "incomplete",
			unit: "count",
			reason: "12 imports unresolved without node_modules",
		};
		const comparison = compareReports(baseline, current);
		expect(comparison.compatibility.comparable).toBe(true);
		const delta = comparison.metrics?.find((d) => d.id === "import-cycle.groups");
		expect(delta?.baseline).toEqual({ state: "complete", value: 1 });
		expect(delta?.current).toEqual({ state: "incomplete" });
		expect(delta?.delta).toBeUndefined();
	});
});

describe("compareFindings", () => {
	test("classifies new, resolved, and persistent findings", () => {
		const baseline = [
			finding("complexity.hotspot", "src/a.ts", 10),
			finding("import-cycle", "src/old.ts", 1),
		];
		const current = [
			finding("complexity.hotspot", "src/a.ts", 10),
			finding("import-cycle", "src/new.ts", 1),
		];
		const result = compareFindings(baseline, current);
		expect(result.persistent).toHaveLength(1);
		expect(result.resolved.map((f) => f.path)).toEqual(["src/old.ts"]);
		expect(result.new.map((f) => f.path)).toEqual(["src/new.ts"]);
	});

	test("tolerates line shifts within a kind+path pair and records the shift", () => {
		const result = compareFindings(
			[finding("complexity.hotspot", "src/a.ts", 10)],
			[finding("complexity.hotspot", "src/a.ts", 42)],
		);
		expect(result.persistent).toHaveLength(1);
		expect(result.persistent[0]?.lineShift).toBe(32);
		expect(result.new).toEqual([]);
		expect(result.resolved).toEqual([]);
	});

	test("reports ambiguous same-file groups as resolved + new pairs, never silently paired", () => {
		const baseline = [
			finding("complexity.hotspot", "src/a.ts", 10),
			finding("complexity.hotspot", "src/a.ts", 60),
		];
		const current = [
			finding("complexity.hotspot", "src/a.ts", 12),
			finding("complexity.hotspot", "src/a.ts", 64),
		];
		const result = compareFindings(baseline, current);
		expect(result.persistent).toEqual([]);
		expect(result.resolved).toHaveLength(2);
		expect(result.new).toHaveLength(2);
	});

	test("reports a 1:2 group as one resolved and two new findings", () => {
		const result = compareFindings(
			[finding("import-cycle", "src/a.ts", 1)],
			[finding("import-cycle", "src/a.ts", 1), finding("import-cycle", "src/a.ts", 20)],
		);
		expect(result.persistent).toEqual([]);
		expect(result.resolved).toHaveLength(1);
		expect(result.new).toHaveLength(2);
	});

	test("orders output deterministically by kind, path, and line", () => {
		const result = compareFindings(
			[],
			[
				finding("import-cycle", "src/b.ts", 5),
				finding("complexity.hotspot", "src/z.ts", 3),
				finding("import-cycle", "src/a.ts", 9),
			],
		);
		expect(result.new.map((f) => `${f.kind}:${f.path}`)).toEqual([
			"complexity.hotspot:src/z.ts",
			"import-cycle:src/a.ts",
			"import-cycle:src/b.ts",
		]);
	});
});

describe("compareMetrics", () => {
	test("reports a null side for a metric absent from one report", () => {
		const baseline = baseReport();
		const current = baseReport();
		const { "import-cycle.groups": _dropped, ...metrics } = current.metrics;
		current.metrics = metrics;
		const deltas = compareMetrics(baseline, current);
		const delta = deltas.find((d) => d.id === "import-cycle.groups");
		expect(delta?.current).toBeNull();
		expect(delta?.baseline).toEqual({ state: "complete", value: 1 });
		expect(delta?.delta).toBeUndefined();
	});
});
