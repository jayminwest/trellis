/**
 * JSON serialization of the versioned report's provider-evidence area (SPEC
 * §6.6, §16.6 — plan `pl-43c5` step 17, trellis-bba6).
 *
 * JSON is the wire artifact: `renderAuditJson` emits exactly the schema
 * 1.1.0 report (never a renderer-local shape), and these tests prove the
 * serialize → load round trip through `loadReportArtifact`
 * (`src/compare/load.ts`) preserves provider provenance, statuses and
 * evidence without loss — while 1.0.0 artifacts still load with their
 * original interpretation, unsupported versions fail clearly, and malformed
 * provider evidence is rejected at the schema boundary.
 *
 * Every report is produced by the real deterministic core over a real temp
 * repository (`auditWorkspace` with a declarative provider selection); the
 * real-binary cases skip where the pinned jscpd artifact is not installed,
 * exactly like the provider-selection core tests.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditWorkspace } from "../audit/audit.ts";
import {
	KNIP_TOOL_AVAILABLE,
	PINNED,
	providerAuditConfig,
	putFile,
	seedClonePair,
	TOOL_AVAILABLE,
} from "../audit/provider-fixtures.ts";
import { loadReportArtifact, ReportArtifactError } from "../compare/load.ts";
import {
	type AuditReport,
	auditReportSchema,
	carriedAnalyses,
	measurementPayload,
	type ReportAnalysis,
} from "../contract/index.ts";
import { renderAuditJson } from "./audit-json.ts";

let dir: string;
let repo: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "trellis-json-providers-"));
	repo = await mkdtemp(join(tmpdir(), "trellis-json-providers-repo-"));
	await seedClonePair(repo);
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
	await rm(repo, { recursive: true, force: true });
});

/** Audit `repo` through the one core with the given provider selection. */
async function audit(providers: Parameters<typeof providerAuditConfig>[0]): Promise<AuditReport> {
	return auditWorkspace(repo, { config: providerAuditConfig(providers), now: PINNED });
}

/** Persist a report exactly as the renderer emits it and load it back through the artifact boundary. */
async function roundTrip(name: string, report: AuditReport): Promise<AuditReport> {
	const path = join(dir, name);
	await writeFile(path, renderAuditJson(report));
	return loadReportArtifact(path);
}

/** Write raw JSON text as an artifact and load it (tampering goes through the same boundary). */
async function loadRaw(name: string, text: string): Promise<AuditReport> {
	const path = join(dir, name);
	await writeFile(path, text);
	return loadReportArtifact(path);
}

/** The carried external analyses of a report (fails fast when absent). */
function externalAnalyses(report: AuditReport): ReportAnalysis[] {
	return carriedAnalyses(report).filter((analysis) => analysis.provider.kind === "external");
}

/** The overall evidence completeness (fails fast on pre-provider artifacts). */
function evidenceCompleteness(report: AuditReport): "complete" | "incomplete" {
	if (report.schemaVersion !== "1.1.0") throw new Error("expected an evidence-carrying report");
	return report.evidence.completeness;
}

describe("renderAuditJson round-trips provider evidence through the artifact boundary", () => {
	test.skipIf(!TOOL_AVAILABLE)(
		"preserves a complete analysis's provenance, statuses and evidence without loss",
		async () => {
			const report = await audit({ jscpd: { mode: "exact" } });
			const loaded = await roundTrip("complete.json", report);
			expect(loaded).toEqual(report);
			const [entry] = externalAnalyses(loaded);
			if (entry === undefined) throw new Error("expected the jscpd evidence entry");
			expect(entry.provider.kind).toBe("external");
			expect(entry.provider.id).toBe("jscpd");
			expect(entry.provider.toolVersion).toBe("5.2.1");
			expect(entry.provider.adapterVersion).toBe("0.1.0");
			expect(entry.provider.mode).toBe("exact");
			// The exact pinned option set travels with the entry, byte-stable by
			// construction order (the same argv always serializes identically).
			expect(Object.keys(entry.provider.options).sort()).toEqual([
				"max-size",
				"min-lines",
				"min-tokens",
				"no-gitignore",
				"reporters",
				"skip-comments",
				"workers",
			]);
			expect(entry.provider.options["min-tokens"]).toBe(50);
			expect(entry.state).toBe("complete");
			expect(entry.scoring).toBe("advisory");
			expect(entry.metricIds).toEqual([]);
			// Asserted coverage — never inferred from an exit status.
			expect(entry.observedCoverage?.analyzedFiles).toEqual(["src/clone-a.ts", "src/clone-b.ts"]);
			// Analysis identity: selection, parser and options survive intact.
			expect(entry.analysis?.selection.sourceSets).toEqual(["production"]);
			expect(entry.analysis?.parser).toEqual({ engine: "jscpd.tokenizer", version: "5.2.1" });
			// Namespaced metrics and findings survive without loss.
			for (const metric of entry.metrics ?? []) {
				expect(metric.id.startsWith("provider.jscpd.")).toBe(true);
			}
			for (const finding of entry.findings ?? []) {
				expect(finding.kind.startsWith("provider.jscpd.")).toBe(true);
			}
			expect(entry.cloneEvidence?.[0]?.members.map((member) => member.path)).toEqual([
				"src/clone-a.ts",
				"src/clone-b.ts",
			]);
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"preserves mixed complete, incomplete and unsupported evidence with located reasons",
		async () => {
			await putFile(repo, "src/tiny.ts", "export const tiny = 1;\n");
			try {
				const report = await audit({ jscpd: { mode: "exact" }, sonarjs: {} });
				const loaded = await roundTrip("mixed.json", report);
				expect(loaded).toEqual(report);
				expect(evidenceCompleteness(loaded)).toBe("incomplete");
				// Evidence incompleteness never flips the native score partial.
				expect(loaded.score.partial).toBe(false);
				const byId = new Map(externalAnalyses(loaded).map((e) => [e.provider.id, e]));
				const jscpd = byId.get("jscpd");
				if (jscpd === undefined) throw new Error("expected the jscpd evidence entry");
				expect(jscpd.state).toBe("incomplete");
				expect(jscpd.reason).toBeDefined();
				expect(jscpd.observedCoverage?.analyzedFiles).toEqual([]);
				const sonarjs = byId.get("sonarjs");
				if (sonarjs === undefined) throw new Error("expected the sonarjs evidence entry");
				expect(sonarjs.state).toBe("unsupported");
				expect(sonarjs.reason).toContain("deferred by docs/sonarjs-decision.md");
			} finally {
				await rm(join(repo, "src/tiny.ts"), { force: true });
			}
		},
	);

	test("preserves requested gated providers as located unsupported evidence", async () => {
		// sonarjs is the gated set; knip delivered its adapter (trellis-8ebc)
		// and now runs per request wherever the pinned tool is installed.
		const report = await audit({ sonarjs: {} });
		const loaded = await roundTrip("undelivered.json", report);
		expect(loaded).toEqual(report);
		expect(loaded.schemaVersion).toBe("1.1.0");
		expect(externalAnalyses(loaded).map((entry) => entry.provider.id)).toEqual(["sonarjs"]);
		for (const entry of externalAnalyses(loaded)) {
			expect(entry.state).toBe("unsupported");
			expect(entry.reason).toBeDefined();
			expect(entry.scoring).toBe("advisory");
		}
		expect(evidenceCompleteness(loaded)).toBe("incomplete");
		expect(loaded.score.partial).toBe(false);
	});

	test.skipIf(!KNIP_TOOL_AVAILABLE)(
		"preserves a complete knip reachability entry's candidates, assumptions and coverage",
		async () => {
			// No entry is declared for the clone-pair workspace, so the reachability
			// model records its assumptions and reports both files as contextual
			// orphan candidates — advisory evidence, never a score contribution.
			const report = await audit({ knip: {} });
			const loaded = await roundTrip("knip.json", report);
			expect(loaded).toEqual(report);
			const knip = externalAnalyses(loaded).find((entry) => entry.provider.id === "knip");
			if (knip === undefined) throw new Error("expected the knip evidence entry");
			expect(knip.state).toBe("complete");
			expect(knip.provider.mode).toBe("contextual");
			expect(knip.scoring).toBe("advisory");
			expect(knip.observedCoverage?.analyzedFiles).toEqual(["src/clone-a.ts", "src/clone-b.ts"]);
			for (const metric of knip.metrics ?? []) {
				expect(metric.id.startsWith("provider.knip.")).toBe(true);
			}
			const assumptions = knip.metrics?.find(
				(metric) => metric.id === "provider.knip.context.assumptions",
			);
			expect(assumptions?.detail).toMatchObject({
				ids: [
					"dependency-context-unverified",
					"no-entries-declared",
					"no-public-surfaces-declared",
					"plugin-discovery-disabled",
				],
			});
			expect(knip.findings?.map((finding) => finding.kind)).toEqual([
				"provider.knip.unused-file",
				"provider.knip.unused-file",
			]);
			// The native score stays untouched by the advisory evidence.
			expect(loaded.score.partial).toBe(false);
		},
		20_000,
	);

	test("round-trips a contract-valid unrequested entry as an explicit absence", async () => {
		const report = await audit({ sonarjs: {} });
		if (report.schemaVersion !== "1.1.0") throw new Error("expected an evidence-carrying report");
		const unrequested: ReportAnalysis = {
			provider: {
				kind: "external",
				id: "zzz",
				toolVersion: "0.0.0",
				adapterVersion: "0.0.0",
				mode: "capability-request",
				options: {},
			},
			state: "unrequested",
			scoring: "advisory",
			metricIds: [],
		};
		const carried: AuditReport = {
			...report,
			evidence: { ...report.evidence, analyses: [...report.evidence.analyses, unrequested] },
		};
		expect(auditReportSchema.parse(carried)).toEqual(carried);
		const loaded = await roundTrip("unrequested.json", carried);
		expect(loaded).toEqual(carried);
		expect(externalAnalyses(loaded).find((entry) => entry.provider.id === "zzz")?.state).toBe(
			"unrequested",
		);
	});
});

describe("renderAuditJson determinism and stable fields", () => {
	test.skipIf(!TOOL_AVAILABLE)(
		"serializes equivalent audits byte-identically apart from the volatile run block",
		async () => {
			const first = await audit({ jscpd: { mode: "exact" } });
			const second = await audit({ jscpd: { mode: "exact" } });
			expect(measurementPayload(second)).toEqual(measurementPayload(first));
			const stable = (report: AuditReport): string =>
				renderAuditJson({ ...report, run: undefined });
			expect(stable(second)).toBe(stable(first));
			// The round trip is idempotent: loading the artifact and re-rendering
			// it produces the same bytes.
			const loaded = await roundTrip("stable.json", first);
			expect(stable(loaded)).toBe(stable(first));
		},
	);

	test("keeps a default native-only audit native-only on the wire", async () => {
		const report = await audit({});
		const parsed = JSON.parse(renderAuditJson(report)) as AuditReport;
		expect(parsed.schemaVersion).toBe("1.1.0");
		// Schema 1.1.0 mandates the evidence area — with native entries only.
		expect(carriedAnalyses(parsed).every((entry) => entry.provider.kind === "native")).toBe(true);
		expect(externalAnalyses(parsed)).toEqual([]);
		for (const metricId of Object.keys(parsed.metrics)) {
			expect(metricId.startsWith("provider.")).toBe(false);
		}
		for (const finding of parsed.findings) {
			expect(finding.kind.startsWith("provider.")).toBe(false);
		}
	});

	test.skipIf(!TOOL_AVAILABLE)(
		"keeps native score contributions native: they sum to the index and reference no provider metric",
		async () => {
			const report = await audit({ jscpd: { mode: "exact" } });
			const sum = report.score.contributions.reduce((total, c) => total + c.points, 0);
			expect(sum).toBeCloseTo(report.score.index, 6);
			const nativeIds = new Set(Object.keys(report.metrics));
			for (const contribution of report.score.contributions) {
				for (const metricId of contribution.metricIds) {
					expect(nativeIds.has(metricId)).toBe(true);
					expect(metricId.startsWith("provider.")).toBe(false);
				}
			}
		},
	);
});

describe("renderAuditJson versioned reading and the schema boundary", () => {
	test("still renders and loads a pre-provider (1.0.0) artifact with its original interpretation", async () => {
		const report = await audit({});
		const legacy = { ...report } as Record<string, unknown>;
		delete legacy.evidence;
		legacy.schemaVersion = "1.0.0";
		const rendered = renderAuditJson(legacy as unknown as AuditReport);
		const loaded = await loadRaw("legacy.json", rendered);
		expect(loaded.schemaVersion).toBe("1.0.0");
		expect(carriedAnalyses(loaded)).toEqual([]);
		expect(loaded.score.index).toBe(report.score.index);
	});

	test("fails clearly on an unsupported schema version, naming the supported ones", async () => {
		const future = { ...(await audit({})), schemaVersion: "2.0.0" };
		const error = await loadRaw("future.json", JSON.stringify(future)).catch(
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(ReportArtifactError);
		expect((error as ReportArtifactError).message).toContain(
			'unsupported report schema version "2.0.0"',
		);
		expect((error as ReportArtifactError).message).toContain("1.0.0, 1.1.0");
	});

	test("rejects malformed provider evidence at the schema boundary before publishing", async () => {
		const report = await audit({ sonarjs: {} });
		if (report.schemaVersion !== "1.1.0") throw new Error("expected an evidence-carrying report");
		const [entry] = externalAnalyses(report);
		if (entry === undefined) throw new Error("expected a provider evidence entry");
		// Measured output without the analysis identity that produced it.
		const fabricated: AuditReport = {
			...report,
			evidence: {
				...report.evidence,
				analyses: [
					...report.evidence.analyses.filter(
						(candidate) => candidate.provider.id !== entry.provider.id,
					),
					{
						...entry,
						analysis: undefined,
						metrics: [{ id: "provider.jscpd.pairs", state: "complete", value: 0, unit: "count" }],
					},
				],
			},
		};
		expect(() => renderAuditJson(fabricated)).toThrow();
		const error = await loadRaw("fabricated.json", JSON.stringify(fabricated)).catch(
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(ReportArtifactError);
		expect((error as ReportArtifactError).message).toContain("invalid audit report");
	});

	test("rejects an external entry that claims a native metric id", async () => {
		const report = await audit({ sonarjs: {} });
		if (report.schemaVersion !== "1.1.0") throw new Error("expected an evidence-carrying report");
		const [nativeMetricId] = Object.keys(report.metrics);
		if (nativeMetricId === undefined) throw new Error("expected a native metric");
		const [entry] = externalAnalyses(report);
		if (entry === undefined) throw new Error("expected a provider evidence entry");
		const claiming: AuditReport = {
			...report,
			evidence: {
				...report.evidence,
				analyses: [
					...report.evidence.analyses,
					{ ...entry, provider: { ...entry.provider, id: "zzz" }, metricIds: [nativeMetricId] },
				],
			},
		};
		expect(() => renderAuditJson(claiming)).toThrow();
	});
});
