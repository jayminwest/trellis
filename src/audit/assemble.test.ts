import { describe, expect, test } from "bun:test";
import {
	auditReportSchema,
	type Finding,
	type MetricValue,
	SCHEMA_VERSION,
	type SourceSet,
} from "../contract/index.ts";
import {
	fixtureNativeAnalysisIdentity,
	fixtureNativeProvider,
} from "../contract/report.fixtures.ts";
import type { SourceInventory } from "../discovery/index.ts";
import type { SafeguardInspection } from "../safeguards/index.ts";
import { scoreSloppiness } from "../scoring/index.ts";
import { countLines, type FileSyntax, parseSource, type SyntaxInventory } from "../syntax/index.ts";
import {
	type AuditMeasurements,
	assembleReport,
	collectMetrics,
	orderFindings,
	reportCoverage,
} from "./assemble.ts";

/** One contract metric, complete by default. */
function metric(id: string, value: number, overrides: Partial<MetricValue> = {}): MetricValue {
	return { id, unit: "count", state: "complete", value, ...overrides };
}

/** One contract finding. */
function finding(kind: string, path: string, line = 1): Finding {
	return {
		kind,
		path,
		range: { start: { line }, end: { line } },
		summary: `${kind} at ${path}:${line}`,
	};
}

/** A minimal source inventory (root package named `fixture`). */
function fakeSource(files: SourceInventory["files"] = []): SourceInventory {
	return {
		root: "/fixture",
		packages: [{ path: ".", name: "fixture", hasManifest: true, declared: true }],
		files,
		excluded: [],
		unsupported: { files: 0, byExtension: {} },
		ignored: [],
		unsupportedPackages: [],
	};
}

/** A real parse of `code` wrapped as a {@link FileSyntax} in `sourceSet`. */
function fakeFile(path: string, sourceSet: SourceSet, code: string): FileSyntax {
	const parsed = parseSource(path, code);
	return {
		path,
		packagePath: ".",
		sourceSet,
		scriptKind: parsed.scriptKind,
		sourceFile: parsed.sourceFile,
		functions: [],
		lines: countLines(parsed.sourceFile),
		signatureCount: 0,
		diagnostics: [],
	};
}

/** A minimal syntax inventory over `files`. */
function fakeSyntax(files: FileSyntax[]): SyntaxInventory {
	return {
		root: "/fixture",
		compilerVersion: "test",
		files,
		functionCount: 0,
		diagnostics: [],
		completeness: "complete",
	};
}

/** The six formula-required metrics, all complete and zero-debt. */
function requiredMetrics(): MetricValue[] {
	return [
		metric("complexity.functions.production", 0),
		metric("duplication.density.production", 0, { unit: "ratio" }),
		metric("duplication.groups.production", 0),
		metric("erosion.eroded-count.production", 0),
		metric("erosion.eroded-share.production", 0, { unit: "ratio" }),
		metric("import-cycle.density", 0, { unit: "ratio" }),
		metric("import-cycle.groups", 0),
	];
}

/**
 * Minimal analysis stubs carrying only what assembly consumes: one measured
 * analysis (a complete native pass over the fake inventory) owning every
 * metric it emits, scored — the registry-derived declarations the real audit
 * supplies (audit.ts).
 */
function fakeMeasurements(metrics: MetricValue[], findings: Finding[] = []): AuditMeasurements {
	return {
		source: fakeSource(),
		syntax: fakeSyntax([]),
		analyses: [
			{
				metrics,
				findings,
				result: {
					provider: fixtureNativeProvider,
					state: "complete",
					analysis: fixtureNativeAnalysisIdentity,
					observedCoverage: { analyzedFiles: [], diagnostics: [], unsupported: [] },
				},
				scoring: "scored",
				metricIds: [...metrics.map((metric) => metric.id)].sort(),
			},
		],
		safeguards: { results: [], findings: [] } satisfies SafeguardInspection,
	};
}

describe("collectMetrics", () => {
	test("sorts metrics by id across sources", () => {
		const collected = collectMetrics([
			{ metrics: [metric("b.two", 2), metric("a.one", 1)] },
			{ metrics: [metric("c.three", 3)] },
		]);
		expect(collected.map((m) => m.id)).toEqual(["a.one", "b.two", "c.three"]);
	});

	test("throws on a duplicate metric id across analyzers", () => {
		expect(() =>
			collectMetrics([{ metrics: [metric("a.one", 1)] }, { metrics: [metric("a.one", 2)] }]),
		).toThrow('duplicate metric id "a.one"');
	});
});

describe("orderFindings", () => {
	test("groups kinds lexicographically while preserving each producer's internal order", () => {
		const ordered = orderFindings([
			{ findings: [finding("import-cycle", "b.ts", 5), finding("complexity.hotspot", "z.ts")] },
			{ findings: [finding("complexity.hotspot", "a.ts"), finding("import-cycle", "a.ts", 2)] },
		]);
		expect(ordered.map((f) => `${f.kind}:${f.path}`)).toEqual([
			"complexity.hotspot:z.ts",
			"complexity.hotspot:a.ts",
			"import-cycle:b.ts",
			"import-cycle:a.ts",
		]);
	});

	test("returns an empty list when no producer has findings", () => {
		expect(orderFindings([{ findings: [] }, { findings: [] }])).toEqual([]);
	});
});

describe("reportCoverage", () => {
	test("pairs per-scope file counts with measured code lines", () => {
		const source = fakeSource([
			{ path: "src/a.ts", sourceSet: "production", packagePath: ".", rule: "default" },
			{ path: "src/a.test.ts", sourceSet: "test", packagePath: ".", rule: "test-basename" },
			{ path: "src/types.d.ts", sourceSet: "declaration-only", packagePath: ".", rule: "decl" },
		]);
		const syntax = fakeSyntax([
			fakeFile("src/a.ts", "production", "const a = 1;\nconst b = 2;\n"),
			fakeFile("src/a.test.ts", "test", "const t = 1;\n"),
			fakeFile("src/types.d.ts", "declaration-only", "export declare const d: number;\n"),
		]);
		const coverage = reportCoverage(source, syntax);
		expect(coverage.production).toEqual({ files: 1, sloc: 2 });
		expect(coverage.test).toEqual({ files: 1, sloc: 1 });
		expect(coverage["declaration-only"]).toEqual({ files: 1, sloc: 1 });
		expect(coverage.generated).toBeUndefined();
	});

	test("reports excluded and unsupported surface as counts only", () => {
		const source: SourceInventory = {
			...fakeSource([
				{ path: "src/a.ts", sourceSet: "production", packagePath: ".", rule: "default" },
			]),
			excluded: [{ path: "dist/out.ts", reason: "build-output" }],
			unsupported: { files: 2, byExtension: { ".py": 2 } },
		};
		const syntax = fakeSyntax([fakeFile("src/a.ts", "production", "const a = 1;\n")]);
		const coverage = reportCoverage(source, syntax);
		expect(coverage.excluded).toMatchObject({ files: 1 });
		expect(coverage.excluded?.sloc).toBeUndefined();
		expect(coverage.unsupported).toMatchObject({ files: 2 });
		expect(coverage.unsupported?.sloc).toBeUndefined();
	});
});

describe("assembleReport", () => {
	test("assembles a schema-valid report with sorted metrics and grouped findings", () => {
		const metrics = requiredMetrics();
		const findings = [finding("import-cycle", "b.ts"), finding("complexity.hotspot", "a.ts")];
		const report = assembleReport(fakeMeasurements(metrics, findings), scoreSloppiness(metrics));
		expect(auditReportSchema.parse(report)).toEqual(report);
		expect(report.schemaVersion).toBe(SCHEMA_VERSION);
		expect(report.completeness).toBe("complete");
		expect(report.score.partial).toBe(false);
		expect(Object.keys(report.metrics)).toEqual([...Object.keys(report.metrics)].sort());
		expect(report.findings.map((f) => f.kind)).toEqual(["complexity.hotspot", "import-cycle"]);
		expect(report.repo).toEqual({ root: "/fixture", identity: "fixture" });
		expect(report.run).toBeUndefined();
	});

	test("attaches run metadata only when provided", () => {
		const metrics = requiredMetrics();
		const scoring = scoreSloppiness(metrics);
		const report = assembleReport(fakeMeasurements(metrics), scoring, {
			auditedAt: "2026-01-02T03:04:05.000Z",
			durationMs: 12,
		});
		expect(report.run).toEqual({ auditedAt: "2026-01-02T03:04:05.000Z", durationMs: 12 });
	});

	test("rolls an incomplete metric up to an incomplete, partial report", () => {
		const metrics = [
			...requiredMetrics(),
			metric("graph.edges.unresolved", 1, { state: "incomplete", reason: "1 unresolved" }),
		];
		const report = assembleReport(fakeMeasurements(metrics), scoreSloppiness(metrics));
		expect(report.completeness).toBe("incomplete");
		expect(report.score.partial).toBe(true);
	});

	test("refuses to publish a report whose score disagrees with its metrics", () => {
		// scoreSloppiness([]) flags missing required metrics (partial), but the
		// fabricated complete metric set rolls up complete — the §6.4 invariant
		// must reject the mismatch rather than publish a misleading headline.
		const metrics = requiredMetrics();
		expect(() => assembleReport(fakeMeasurements(metrics), scoreSloppiness([]))).toThrow();
	});

	test("omits repo identity when the root package has no manifest name", () => {
		const source = fakeSource();
		source.packages = [{ path: ".", hasManifest: false, declared: false }];
		const metrics = requiredMetrics();
		const report = assembleReport(
			{ ...fakeMeasurements(metrics), source },
			scoreSloppiness(metrics),
		);
		expect(report.repo).toEqual({ root: "/fixture" });
	});
});
