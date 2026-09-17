import { describe, expect, test } from "bun:test";
import {
	type AnalysisIdentity,
	type Finding,
	type MetricValue,
	SCHEMA_VERSION,
} from "../contract/index.ts";
import {
	fixtureNativeAnalysisIdentity,
	fixtureNativeProvider,
} from "../contract/report.fixtures.ts";
import type { SourceInventory } from "../discovery/index.ts";
import type { SafeguardInspection } from "../safeguards/index.ts";
import { scoreSloppiness } from "../scoring/index.ts";
import type { FileSyntax, SyntaxInventory } from "../syntax/index.ts";
import { type AuditMeasurements, assembleReport } from "./assemble.ts";

/**
 * Evidence-area assembly tests (SPEC §6.6, trellis-a24d): the report fold
 * carries per-analysis provenance/status with the declared scoring roles and
 * metric ownership, keeps overall evidence completeness independent from
 * score completeness, and never duplicates native measured output per entry.
 */

/** One contract metric, complete by default. */
function metric(id: string, value: number, overrides: Partial<MetricValue> = {}): MetricValue {
	return { id, unit: "count", state: "complete", value, ...overrides };
}

/** The seven formula-required metrics, all complete and zero-debt. */
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

/** Minimal measurement stubs carrying only what assembly consumes. */
function fakeMeasurements(): AuditMeasurements {
	return {
		source: fakeSource(),
		syntax: fakeSyntax([]),
		analyses: [],
		safeguards: { results: [], findings: [] } satisfies SafeguardInspection,
	};
}

describe("assembleReport evidence area", () => {
	/** A native analysis identity over a two-file selection with a parse-diagnostic gap. */
	const incompleteIdentity: AnalysisIdentity = {
		selection: {
			sourceSets: ["production"],
			files: [
				{ path: "src/a.ts", fingerprint: "a".repeat(64) },
				{ path: "src/b.ts", fingerprint: "b".repeat(64) },
			],
		},
		parser: { engine: "trellis.typescript", version: "5.9.3" },
		options: {},
	};

	/** One measured analysis's evidence contribution over the fixture identity. */
	function contribution(
		metrics: MetricValue[],
		overrides: {
			findings?: Finding[];
			providerId?: string;
			scoring?: "scored" | "advisory";
			state?: "complete" | "incomplete";
			metricIds?: readonly string[];
		} = {},
	) {
		const {
			providerId = "trellis.duplication",
			scoring = "scored",
			state = "complete",
		} = overrides;
		return {
			metrics,
			findings: overrides.findings ?? [],
			result: {
				provider: { ...fixtureNativeProvider, id: providerId },
				state,
				...(state === "complete"
					? {}
					: {
							reason: "1 selected file produced parse diagnostics",
							analysis: incompleteIdentity,
							observedCoverage: {
								analyzedFiles: ["src/a.ts"],
								diagnostics: [{ path: "src/b.ts", message: "parse error" }],
								unsupported: [],
							},
						}),
				...(state === "complete"
					? {
							analysis: fixtureNativeAnalysisIdentity,
							observedCoverage: {
								analyzedFiles: [],
								diagnostics: [],
								unsupported: [],
							},
						}
					: {}),
				// The real wrapped runs carry their measured output on the result
				// too (by reference) — assembly must never duplicate it per entry.
				metrics,
				findings: overrides.findings ?? [],
			},
			scoring,
			metricIds: overrides.metricIds ?? [...metrics.map((metric) => metric.id)].sort(),
		};
	}

	test("carries per-analysis provenance, roles and ownership, ordered by provider id", () => {
		const metrics = requiredMetrics();
		const inputs = [
			contribution(metrics.slice(0, 3), { providerId: "trellis.duplication" }),
			contribution(metrics.slice(3), { providerId: "trellis.complexity" }),
		];
		const report = assembleReport(
			{ ...fakeMeasurements(), analyses: inputs },
			scoreSloppiness(metrics),
		);
		if (report.schemaVersion !== SCHEMA_VERSION) {
			throw new Error("expected an evidence-carrying report");
		}
		expect(report.evidence.analyses.map((analysis) => analysis.provider.id)).toEqual([
			"trellis.complexity",
			"trellis.duplication",
		]);
		for (const analysis of report.evidence.analyses) {
			expect(analysis.scoring).toBe("scored");
			// Native evidence lives in the report's areas, never duplicated per entry.
			expect(analysis.metrics).toBeUndefined();
			expect(analysis.findings).toBeUndefined();
			expect(analysis.cloneEvidence).toBeUndefined();
			for (const metricId of analysis.metricIds) {
				expect(report.metrics[metricId]).toBeDefined();
			}
		}
		expect(report.evidence.analyses.flatMap((analysis) => [...analysis.metricIds]).sort()).toEqual(
			[...Object.keys(report.metrics)].sort(),
		);
	});

	test("an incomplete advisory analysis degrades the evidence without flipping the score (AC1)", () => {
		const scored = contribution(requiredMetrics(), { providerId: "trellis.duplication" });
		const advisory = contribution([metric("complexity.cc.p50.test", 3)], {
			providerId: "trellis.complexity",
			scoring: "advisory",
			state: "incomplete",
		});
		const metrics = [...scored.metrics, ...advisory.metrics];
		const report = assembleReport(
			{ ...fakeMeasurements(), analyses: [scored, advisory] },
			scoreSloppiness(metrics),
		);
		if (report.schemaVersion !== SCHEMA_VERSION) {
			throw new Error("expected an evidence-carrying report");
		}
		expect(report.evidence.completeness).toBe("incomplete");
		expect(report.score.partial).toBe(false);
		expect(report.completeness).toBe("complete");
	});

	test("a scored analysis gap keeps the headline partial (AC1)", () => {
		const scored = contribution(
			requiredMetrics().map((metric) => ({
				...metric,
				state: "incomplete" as const,
				reason: "1 selected file produced parse diagnostics",
			})),
			{ providerId: "trellis.duplication", state: "incomplete" },
		);
		const metrics = scored.metrics;
		// The scorer flags the incomplete metrics partial; the declared scored
		// input agrees — the assembled headline stays honest.
		const report = assembleReport(
			{ ...fakeMeasurements(), analyses: [{ ...scored, metrics }] },
			scoreSloppiness(metrics),
		);
		if (report.schemaVersion !== SCHEMA_VERSION) {
			throw new Error("expected an evidence-carrying report");
		}
		expect(report.score.partial).toBe(true);
		expect(report.evidence.completeness).toBe("incomplete");
	});

	test("refuses a score that disagrees with the declared scored inputs", () => {
		// A scored analysis that shows a gap demands a partial headline; a
		// scorer that saw only complete metrics says otherwise — assembly
		// must reject the mismatch rather than publish either lie.
		const scored = contribution(requiredMetrics(), {
			providerId: "trellis.duplication",
			state: "incomplete",
		});
		expect(() =>
			assembleReport(
				{ ...fakeMeasurements(), analyses: [scored] },
				scoreSloppiness(scored.metrics),
			),
		).toThrow(/partial/);
	});
});
