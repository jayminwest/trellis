import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jscpdAnalysis, nativeComplexityAnalysis } from "../compare/fixtures.ts";
import {
	ANALYZER_VERSION,
	type AuditReport,
	type EvidenceArea,
	type ReportAnalysis,
	SCHEMA_VERSION,
	SCORING_VERSION,
} from "../contract/index.ts";
import { fixtureEvidenceArea, fixtureNativeAnalysis } from "../contract/report.fixtures.ts";
import { openStore, repoIdentity, type Store } from "../store/index.ts";
import { buildHistory } from "./dashboard.ts";

/** A minimal but §6.4-valid audit report fixture; run metadata is pinned for determinism. */
function makeAuditReport(
	overrides: {
		root?: string;
		identity?: string;
		scoringVersion?: string;
		index?: number;
		auditedAt?: string;
		evidence?: EvidenceArea;
	} = {},
): AuditReport {
	return {
		schemaVersion: SCHEMA_VERSION,
		analyzerVersion: ANALYZER_VERSION,
		scoringVersion: overrides.scoringVersion ?? SCORING_VERSION,
		repo: {
			root: overrides.root ?? "/tmp/fixture",
			...(overrides.identity === undefined ? { identity: "fixture" } : {}),
		},
		sourceCoverage: { production: { files: 1, sloc: 10 }, test: { files: 0 } },
		completeness: "complete",
		evidence: overrides.evidence ?? fixtureEvidenceArea(["complexity.average-cc"]),
		metrics: {
			"complexity.average-cc": {
				id: "complexity.average-cc",
				state: "complete",
				value: 2,
				unit: "cc",
			},
		},
		score: {
			index: overrides.index ?? 12,
			direction: "lower-is-better",
			partial: false,
			contributions: [
				{ dimension: "complexity", points: 12, metricIds: ["complexity.average-cc"] },
			],
		},
		findings: [],
		safeguards: [],
		run: { auditedAt: overrides.auditedAt ?? "2026-06-06T00:00:00.000Z" },
	};
}

const IDENTITY = repoIdentity("/tmp/fixture", "fixture");

describe("buildHistory", () => {
	let store: Store;
	beforeEach(() => {
		store = openStore(":memory:");
	});
	afterEach(() => {
		store.close();
	});

	test("an empty store yields empty sections", () => {
		const report = buildHistory(store);
		expect(report.audits.snapshot).toEqual([]);
		expect(report.audits.repos).toEqual([]);
		expect(report.scope).toEqual({ repo: null, since: null });
	});

	test("snapshots the latest audit run per repo with the compatible index delta", () => {
		store.insertAuditRun(makeAuditReport({ index: 10, auditedAt: "2026-06-01T00:00:00.000Z" }));
		store.insertAuditRun(makeAuditReport({ index: 14, auditedAt: "2026-06-06T00:00:00.000Z" }));
		const report = buildHistory(store);
		expect(report.audits.snapshot).toHaveLength(1);
		const entry = report.audits.snapshot[0];
		expect(entry?.repo).toBe(IDENTITY);
		expect(entry?.index).toBe(14);
		expect(entry?.partial).toBe(false);
		expect(entry?.runs).toBe(2);
		// Positive delta = worse (lower is better).
		expect(entry?.indexDelta).toBe(4);
	});

	test("a first run has a null index delta", () => {
		store.insertAuditRun(makeAuditReport({ index: 7 }));
		const entry = buildHistory(store).audits.snapshot[0];
		expect(entry?.indexDelta).toBeNull();
	});

	test("the per-repo series selects only §3.5-compatible runs", () => {
		store.insertAuditRun(
			makeAuditReport({
				index: 30,
				scoringVersion: "0.0.1-old",
				auditedAt: "2026-06-01T00:00:00.000Z",
			}),
		);
		store.insertAuditRun(makeAuditReport({ index: 10, auditedAt: "2026-06-02T00:00:00.000Z" }));
		store.insertAuditRun(makeAuditReport({ index: 12, auditedAt: "2026-06-03T00:00:00.000Z" }));
		const report = buildHistory(store);
		const detail = report.audits.repos[0];
		// The old-scoring-version run is a different scale — excluded, never trended.
		expect(detail?.runs.map((r) => r.index)).toEqual([10, 12]);
		// The delta spans the two compatible runs only.
		expect(report.audits.snapshot[0]?.indexDelta).toBe(2);
	});

	test("the since window floors the series and run count but not the snapshot", () => {
		store.insertAuditRun(makeAuditReport({ index: 10, auditedAt: "2026-06-01T00:00:00.000Z" }));
		store.insertAuditRun(makeAuditReport({ index: 14, auditedAt: "2026-06-06T00:00:00.000Z" }));
		const report = buildHistory(store, { since: "2026-06-05T00:00:00.000Z" });
		expect(report.scope.since).toBe("2026-06-05T00:00:00.000Z");
		expect(report.audits.snapshot[0]?.runs).toBe(1);
		expect(report.audits.repos[0]?.runs.map((r) => r.index)).toEqual([14]);
	});

	test("the repo filter narrows both sections", () => {
		store.insertAuditRun(makeAuditReport({ root: "/tmp/a", identity: "a" }));
		store.insertAuditRun(makeAuditReport({ root: "/tmp/b", identity: "b" }));
		const identity = repoIdentity("/tmp/a", "a");
		const report = buildHistory(store, { repo: identity });
		expect(report.audits.snapshot.map((e) => e.repo)).toEqual([identity]);
	});

	test("an advisory-only provider change never fragments the per-repo series", () => {
		const withEvidence = (analyses: readonly ReportAnalysis[]): EvidenceArea => ({
			completeness: "complete",
			analyses: [...analyses],
		});
		store.insertAuditRun(
			makeAuditReport({
				index: 30,
				auditedAt: "2026-07-01T00:00:00.000Z",
				evidence: withEvidence([fixtureNativeAnalysis(["complexity.average-cc"])]),
			}),
		);
		// An advisory external provider is added, then upgraded, then dropped.
		store.insertAuditRun(
			makeAuditReport({
				index: 25,
				auditedAt: "2026-07-02T00:00:00.000Z",
				evidence: withEvidence([jscpdAnalysis(), fixtureNativeAnalysis(["complexity.average-cc"])]),
			}),
		);
		store.insertAuditRun(
			makeAuditReport({
				index: 20,
				auditedAt: "2026-07-03T00:00:00.000Z",
				evidence: withEvidence([
					jscpdAnalysis({ toolVersion: "5.3.0" }),
					fixtureNativeAnalysis(["complexity.average-cc"]),
				]),
			}),
		);
		store.insertAuditRun(
			makeAuditReport({
				index: 18,
				auditedAt: "2026-07-04T00:00:00.000Z",
				evidence: withEvidence([fixtureNativeAnalysis(["complexity.average-cc"])]),
			}),
		);

		const report = buildHistory(store);
		// The native score series spans every run (§16.6): advisory provider
		// changes never fragment it, and the delta spans the last two points.
		expect(report.audits.repos[0]?.runs.map((run) => run.index)).toEqual([30, 25, 20, 18]);
		expect(report.audits.snapshot[0]?.indexDelta).toBe(-2);
	});

	test("a changed scored basis starts a distinct, clearly marked series", () => {
		const alteredEvidence = (): EvidenceArea => ({
			completeness: "complete",
			analyses: [
				nativeComplexityAnalysis({
					toolVersion: "9.9.9",
					metricIds: ["complexity.average-cc"],
				}),
			],
		});
		store.insertAuditRun(makeAuditReport({ index: 30, auditedAt: "2026-07-01T00:00:00.000Z" }));
		// The scored analysis's pinned tool changed: same core versions, a
		// different scored measurement.
		store.insertAuditRun(
			makeAuditReport({
				index: 5,
				auditedAt: "2026-07-02T00:00:00.000Z",
				evidence: alteredEvidence(),
			}),
		);

		// While the altered basis is the latest run, its series restarts: the
		// old run never silently joins it, and the delta reads as a first run.
		let report = buildHistory(store);
		expect(report.audits.repos[0]?.runs.map((run) => run.index)).toEqual([5]);
		expect(report.audits.snapshot[0]?.indexDelta).toBeNull();

		// A later run back on the original basis anchors its own series: the
		// altered run is excluded — a distinct series, never a false trend.
		store.insertAuditRun(makeAuditReport({ index: 20, auditedAt: "2026-07-03T00:00:00.000Z" }));
		report = buildHistory(store);
		expect(report.audits.repos[0]?.runs.map((run) => run.index)).toEqual([30, 20]);
		expect(report.audits.snapshot[0]?.indexDelta).toBe(-10);
	});

	test("a latest foreign row headlines the snapshot but never implies a series", () => {
		const dir = mkdtempSync(join(tmpdir(), "trellis-history-foreign-"));
		const fileStore = openStore(join(dir, "trellis.db"));
		try {
			fileStore.insertAuditRun(
				makeAuditReport({ root: dir, index: 12, auditedAt: "2026-07-01T00:00:00.000Z" }),
			);
			// A foreign writer's newest row: columns that look fine, JSON that is
			// not a report this trellis can interpret.
			const raw = new Database(join(dir, "trellis.db"));
			raw
				.query(
					`INSERT INTO audit_runs
					 (repo_root, repo_identity, schema_version, analyzer_version, scoring_version,
					  sloppiness_index, partial, completeness, report_json, audited_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					dir,
					repoIdentity(dir, "fixture"),
					SCHEMA_VERSION,
					ANALYZER_VERSION,
					SCORING_VERSION,
					99,
					0,
					"complete",
					'{"schemaVersion":"1.1.0"}',
					"2026-07-02T00:00:00.000Z",
				);
			raw.close();

			const report = buildHistory(fileStore);
			const identity = repoIdentity(dir, "fixture");
			// The snapshot headlines the latest row's recorded columns…
			expect(report.audits.snapshot[0]?.repo).toBe(identity);
			expect(report.audits.snapshot[0]?.index).toBe(99);
			// …but its unknown provenance implies neither a comparable series
			// nor an index delta (AC: unknown provenance is never compatibility).
			expect(report.audits.repos).toEqual([]);
			expect(report.audits.snapshot[0]?.indexDelta).toBeNull();
		} finally {
			fileStore.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
