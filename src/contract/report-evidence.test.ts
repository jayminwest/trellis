import { describe, expect, test } from "bun:test";
import {
	externalProvider,
	fullAnalysis,
	fullCoverage,
	partialCoverage,
} from "./analysis-result.fixtures.ts";
import type { ReportAnalysis } from "./evidence.ts";
import { fixtureNativeAnalysis, fixtureNativeProvider } from "./report.fixtures.ts";
import {
	auditReportSchema,
	type EvidenceAuditReport,
	type PreProviderAuditReport,
} from "./report.ts";
import { SCHEMA_VERSION } from "./version.ts";

/**
 * Evidence vs score completeness on the versioned report (SPEC §16.2,
 * trellis-a24d): an incomplete advisory analysis degrades the overall
 * evidence without flipping a complete native score, a scored
 * prerequisite's failure still marks the score partial, unrequested and
 * empty-successful analyses stay distinguishable, and metric ownership,
 * score contributors and the evidence status are cross-validated.
 */

/** Parse a report and narrow it to the evidence-carrying member (any other version throws). */
function parseEvidenceReport(report: unknown): EvidenceAuditReport {
	const parsed = auditReportSchema.parse(report);
	if (parsed.schemaVersion !== SCHEMA_VERSION) {
		throw new Error(`expected schema version ${SCHEMA_VERSION}, got ${parsed.schemaVersion}`);
	}
	return parsed;
}

/** The measurement body both versions share, as a pre-provider report. */
function baseReport(): PreProviderAuditReport {
	return {
		schemaVersion: "1.0.0",
		analyzerVersion: "0.2.0",
		scoringVersion: "0.1.0-provisional",
		repo: { root: "/abs/path", identity: "github.com/jayminwest/trellis" },
		sourceCoverage: {
			production: { files: 210, sloc: 13280 },
			test: { files: 96, sloc: 5100 },
			generated: { files: 4 },
			unsupported: { files: 30, note: "non-TS sources, not analyzed" },
		},
		completeness: "complete",
		metrics: {
			"duplication.density": {
				id: "duplication.density",
				state: "complete",
				value: 0.031,
				unit: "ratio",
				numerator: 412,
				denominator: 13280,
			},
		},
		score: {
			index: 27,
			direction: "lower-is-better",
			partial: false,
			contributions: [{ dimension: "duplication", points: 12, metricIds: ["duplication.density"] }],
		},
		findings: [
			{
				kind: "complexity.hotspot",
				path: "src/report/build.ts",
				range: { start: { line: 41 }, end: { line: 128 } },
				summary: "CC 23, mass 214",
			},
		],
		safeguards: [
			{
				id: "pre-commit-hook",
				evidence: "structurally-wired",
				locations: [{ path: "scripts/hooks/pre-commit" }],
			},
		],
	};
}

/** A scored native analysis entry owning `metricIds` (the duplication analyzer's identity). */
function scoredNative(metricIds: readonly string[]): ReportAnalysis {
	return {
		...fixtureNativeAnalysis(metricIds),
		provider: { ...fixtureNativeProvider, id: "trellis.duplication" },
	};
}

/** An incomplete native analysis entry: a parse-diagnostic coverage gap (AC1's scored prerequisite failure). */
function incompleteScoredNative(metricIds: readonly string[]): ReportAnalysis {
	return {
		...scoredNative(metricIds),
		state: "incomplete",
		reason: "1 selected file produced parse diagnostics",
		analysis: {
			selection: {
				sourceSets: ["production"],
				files: [
					{ path: "src/a.ts", fingerprint: "a".repeat(64) },
					{ path: "src/b.ts", fingerprint: "b".repeat(64) },
				],
			},
			parser: { engine: "trellis.typescript", version: "5.9.3" },
			options: {},
		},
		observedCoverage: partialCoverage,
	};
}

/** An advisory external analysis entry in the given state (never a scored input). */
function advisoryExternal(
	state: "unrequested" | "unavailable" | "incomplete" | "complete",
): ReportAnalysis {
	switch (state) {
		case "unrequested":
			return { scoring: "advisory", metricIds: [], provider: externalProvider, state };
		case "unavailable":
			return {
				scoring: "advisory",
				metricIds: [],
				provider: externalProvider,
				state,
				reason: "pinned tool not installed",
			};
		case "incomplete":
			return {
				scoring: "advisory",
				metricIds: [],
				provider: externalProvider,
				state,
				analysis: fullAnalysis,
				reason: "2 of 3 selected files analyzed",
				observedCoverage: partialCoverage,
			};
		case "complete":
			return {
				scoring: "advisory",
				metricIds: [],
				provider: externalProvider,
				state,
				analysis: fullAnalysis,
				observedCoverage: fullCoverage,
			};
	}
}

/** A minimal valid schema-1.1.0 report: one scored native analysis owning the measured metric. */
function evidenceReport(): EvidenceAuditReport {
	return {
		...baseReport(),
		schemaVersion: SCHEMA_VERSION,
		findings: baseReport().findings.map((finding) => ({
			...finding,
			identity: { version: "1.0.0", state: "ambiguous", reason: "anonymous" },
		})),
		evidence: {
			completeness: "complete",
			analyses: [scoredNative(["duplication.density"])],
		},
	};
}

describe("auditReportSchema completeness split (§16.2)", () => {
	test("accepts an incomplete advisory analysis: evidence incomplete, native score complete (AC1)", () => {
		const report = {
			...evidenceReport(),
			evidence: {
				completeness: "incomplete",
				analyses: [advisoryExternal("incomplete"), scoredNative(["duplication.density"])],
			},
		};
		const parsed = parseEvidenceReport(report);
		expect(parsed.evidence.completeness).toBe("incomplete");
		expect(parsed.score.partial).toBe(false);
		expect(parsed.completeness).toBe("complete");
	});

	test("rejects flipping a complete native score partial over an advisory analysis (AC1)", () => {
		const report = {
			...evidenceReport(),
			evidence: {
				completeness: "incomplete",
				analyses: [advisoryExternal("incomplete"), scoredNative(["duplication.density"])],
			},
			score: { ...evidenceReport().score, partial: true },
		};
		expect(auditReportSchema.safeParse(report).success).toBe(false);
	});

	test("keeps a scored prerequisite failure marking the score partial (AC1)", () => {
		const report = {
			...evidenceReport(),
			evidence: {
				completeness: "incomplete",
				analyses: [incompleteScoredNative(["duplication.density"])],
			},
			score: { ...evidenceReport().score, partial: true },
		};
		expect(auditReportSchema.safeParse(report).success).toBe(true);
		// The same scored failure without the partial headline is dishonest.
		const unflagged = {
			...report,
			score: { ...report.score, partial: false },
		};
		expect(auditReportSchema.safeParse(unflagged).success).toBe(false);
	});

	test("keeps an incomplete scored-owned metric flagging the headline partial (AC5, native behavior)", () => {
		const report = {
			...evidenceReport(),
			completeness: "incomplete",
			evidence: {
				completeness: "incomplete",
				analyses: [scoredNative(["duplication.density", "duplication.groups.production"])],
			},
			metrics: {
				...evidenceReport().metrics,
				"duplication.groups.production": {
					id: "duplication.groups.production",
					state: "incomplete",
					unit: "count",
					reason: "budget exhausted before pairing completed",
				},
			},
			score: { ...evidenceReport().score, partial: true },
		};
		expect(auditReportSchema.safeParse(report).success).toBe(true);
		const unflagged = { ...report, score: { ...report.score, partial: false } };
		expect(auditReportSchema.safeParse(unflagged).success).toBe(false);
	});

	test("keeps unrequested providers and empty successful measurements distinguishable (AC2)", () => {
		const unrequested = {
			...evidenceReport(),
			evidence: {
				completeness: "complete",
				analyses: [advisoryExternal("unrequested"), scoredNative(["duplication.density"])],
			},
		};
		const parsedUnrequested = parseEvidenceReport(unrequested);
		expect(parsedUnrequested.evidence.completeness).toBe("complete");
		const states = parsedUnrequested.evidence.analyses.map((analysis) => analysis.state);
		expect(states).toEqual(["unrequested", "complete"]);
		// An honest empty measurement (complete over exactly zero selected
		// files) is a different, equally visible state — and its coverage and
		// diagnostics stay available to consumers.
		const emptySelection = {
			...advisoryExternal("complete"),
			analysis: {
				selection: { sourceSets: ["production"], files: [] },
				parser: { engine: "jscpd.tokenizer", version: "5.2.1" },
				options: {},
			},
			observedCoverage: {
				analyzedFiles: [],
				bySourceSet: { production: 0 },
				diagnostics: [],
				unsupported: [],
			},
		};
		const parsedEmpty = parseEvidenceReport({
			...unrequested,
			evidence: {
				completeness: "complete",
				analyses: [emptySelection, scoredNative(["duplication.density"])],
			},
		});
		const empty = parsedEmpty.evidence.analyses[0];
		expect(empty?.state).toBe("complete");
		expect(empty?.observedCoverage?.analyzedFiles).toEqual([]);
		expect(empty?.observedCoverage?.diagnostics).toEqual([]);
		expect(parsedEmpty.evidence.analyses.map((analysis) => analysis.state)).toEqual([
			"complete",
			"complete",
		]);
	});

	test("validates metric ownership across entries, map and contributors (AC3)", () => {
		const base = evidenceReport();
		// A report metric no analysis owns.
		const orphan = {
			...base,
			metrics: {
				...base.metrics,
				"complexity.functions.production": {
					id: "complexity.functions.production",
					state: "complete",
					value: 3,
					unit: "count",
				},
			},
		};
		expect(auditReportSchema.safeParse(orphan).success).toBe(false);
		// An owned metric absent from the map.
		const absent = {
			...base,
			evidence: {
				completeness: "complete",
				analyses: [scoredNative(["duplication.density", "duplication.groups.production"])],
			},
		};
		expect(auditReportSchema.safeParse(absent).success).toBe(false);
		// One metric owned by two analyses.
		const duplicate = {
			...base,
			evidence: {
				completeness: "complete",
				analyses: [
					scoredNative(["duplication.density"]),
					{
						...scoredNative(["duplication.density"]),
						provider: { ...fixtureNativeProvider, id: "trellis.other" },
					},
				],
			},
		};
		expect(auditReportSchema.safeParse(duplicate).success).toBe(false);
		// A contribution tracing to advisory evidence: advisory evidence never
		// enters the score (the metric lives inside the external entry, never
		// in the metrics map).
		const advisoryOwned = {
			...base,
			evidence: {
				completeness: "complete",
				analyses: [
					{
						...advisoryExternal("complete"),
						metrics: [{ id: "provider.jscpd.pairs", state: "complete", value: 1, unit: "count" }],
					},
					scoredNative(["duplication.density"]),
				],
			},
			score: {
				...base.score,
				contributions: [
					...base.score.contributions,
					{ dimension: "provider-duplication", points: 0, metricIds: ["provider.jscpd.pairs"] },
				],
			},
		};
		expect(auditReportSchema.safeParse(advisoryOwned).success).toBe(false);
		// The same advisory evidence carried in-entry (never inside the
		// metrics map) and unscored is fine: the contribution check and the
		// ownership check both pass with the native score untouched.
		const advisoryUnscored = {
			...base,
			evidence: advisoryOwned.evidence,
		};
		expect(auditReportSchema.safeParse(advisoryUnscored).success).toBe(true);
	});

	test("rejects an evidence-completeness claim that disagrees with the analyses (AC3)", () => {
		const report = {
			...evidenceReport(),
			evidence: {
				completeness: "complete",
				analyses: [scoredNative(["duplication.density"]), advisoryExternal("unavailable")],
			},
		};
		expect(auditReportSchema.safeParse(report).success).toBe(false);
	});
});
