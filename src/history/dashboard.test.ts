import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	ANALYZER_VERSION,
	type AuditReport,
	SCHEMA_VERSION,
	SCORING_VERSION,
} from "../contract/index.ts";
import type { Report } from "../report/index.ts";
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

/** A §6.3-valid legacy readiness report fixture. */
function makeLegacyReport(overrides: Partial<Report> = {}): Report {
	return {
		repo: "warren",
		rubricVersion: "1.0.0",
		scoredAt: "2026-05-01T00:00:00.000Z",
		commit: "c0",
		level: 3,
		passRate: 0.75,
		coverage: 0.9,
		apps: { ".": { description: "warren" } },
		criteria: { a: { numerator: 1, denominator: 1, rationale: "x" } },
		...overrides,
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
		expect(report.legacy).toEqual([]);
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
		store.insertRun(makeLegacyReport({ repo: "warren" }));
		const identity = repoIdentity("/tmp/a", "a");
		const report = buildHistory(store, { repo: identity });
		expect(report.audits.snapshot.map((e) => e.repo)).toEqual([identity]);
		expect(report.legacy).toEqual([]);
	});

	test("legacy readiness runs surface in a visibly distinct section, never mixed", () => {
		store.insertAuditRun(makeAuditReport({ index: 12 }));
		store.insertRun(makeLegacyReport({ level: 4, passRate: 0.8 }));
		store.insertRun(makeLegacyReport({ level: 3, scoredAt: "2026-05-02T00:00:00.000Z" }));
		const report = buildHistory(store);
		// The sloppiness sections carry audit runs only.
		expect(report.audits.snapshot).toHaveLength(1);
		expect(report.audits.snapshot[0]?.index).toBe(12);
		// The legacy section carries readiness numbers labeled by repo, with no index anywhere.
		expect(report.legacy).toHaveLength(1);
		const legacy = report.legacy[0];
		expect(legacy?.repo).toBe("warren");
		expect(legacy?.runs).toBe(2);
		expect(legacy?.latestLevel).toBe(3);
		expect(legacy?.latestPassRate).toBe(0.75);
		expect(legacy && "index" in legacy).toBe(false);
	});
});
