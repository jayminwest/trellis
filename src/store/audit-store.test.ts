import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditWorkspace } from "../audit/index.ts";
import {
	ANALYZER_VERSION,
	type AuditReport,
	SCHEMA_VERSION,
	SCORING_VERSION,
} from "../contract/index.ts";
import { fixtureEvidenceArea } from "../contract/report.fixtures.ts";
import { renderAuditJson } from "../report/audit-json.ts";
import { openStore, repoIdentity, type Store, storedAuditReport } from "./index.ts";
import { migrate } from "./migrate.ts";

/** A minimal but §6.4-valid audit report fixture; run metadata is pinned for determinism. */
function makeAuditReport(
	overrides: {
		root?: string;
		identity?: string;
		analyzerVersion?: string;
		scoringVersion?: string;
		index?: number;
		auditedAt?: string;
	} = {},
): AuditReport {
	return {
		schemaVersion: SCHEMA_VERSION,
		analyzerVersion: overrides.analyzerVersion ?? ANALYZER_VERSION,
		scoringVersion: overrides.scoringVersion ?? SCORING_VERSION,
		repo: {
			root: overrides.root ?? "/tmp/fixture",
			...(overrides.identity === undefined ? { identity: "fixture" } : {}),
		},
		sourceCoverage: { production: { files: 1, sloc: 10 }, test: { files: 0 } },
		completeness: "complete",
		evidence: fixtureEvidenceArea(["complexity.average-cc"]),
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

describe("migration 0002", () => {
	test("a fresh DB gains audit_runs alongside the preserved legacy tables", () => {
		const db = new Database(":memory:");
		migrate(db);
		const names = db
			.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all()
			.map((r) => r.name);
		expect(names).toContain("audit_runs");
		expect(names).toContain("runs");
		expect(names).toContain("criterion_results");
		expect(names).toContain("investigation_cache");
		db.close();
	});

	test("a populated legacy database migrates without losing original report records", () => {
		const db = new Database(":memory:");
		// Simulate a legacy (user_version 1) database exactly as the retired
		// readiness product left it: schema 0001 plus real rows.
		const initial = readFileSync(join(import.meta.dir, "migrations", "0001-initial.sql"), "utf8");
		db.exec(initial);
		db.exec("PRAGMA user_version = 1");
		db.query(
			`INSERT INTO runs (repo, commit_sha, rubric_version, level, pass_rate, coverage, report_json, scored_at)
			 VALUES ('legacy-repo', 'abc123', '1.0.0', 3, 0.75, 0.9, '{"legacy":true}', '2026-01-01T00:00:00.000Z')`,
		).run();
		db.query(
			`INSERT INTO criterion_results (run_id, criterion, numerator, denominator, na_kind, rationale)
			 VALUES (1, 'agents_md', 1, 1, NULL, 'present')`,
		).run();
		db.query(
			`INSERT INTO investigation_cache (repo, commit_sha, area, findings_json, created_at)
			 VALUES ('legacy-repo', 'abc123', 'debt', '[]', '2026-01-01T00:00:00.000Z')`,
		).run();

		migrate(db);

		const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
		expect(version?.user_version).toBe(2);
		const run = db
			.query<{ repo: string; level: number; report_json: string }, []>(
				"SELECT repo, level, report_json FROM runs",
			)
			.get();
		expect(run).toEqual({ repo: "legacy-repo", level: 3, report_json: '{"legacy":true}' });
		const criterion = db
			.query<{ criterion: string; rationale: string }, []>(
				"SELECT criterion, rationale FROM criterion_results",
			)
			.get();
		expect(criterion).toEqual({ criterion: "agents_md", rationale: "present" });
		const cache = db.query<{ area: string }, []>("SELECT area FROM investigation_cache").get();
		expect(cache?.area).toBe("debt");
		db.close();
	});
});

describe("audit run storage", () => {
	let dir: string;
	let store: Store;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "trellis-audit-store-"));
		store = openStore(join(dir, "trellis.db"));
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("insertAuditRun round-trips a §6.4 report with a sloppiness-tagged row", () => {
		const report = makeAuditReport({ root: dir, index: 27 });
		const runId = store.insertAuditRun(report);
		expect(runId).toBeGreaterThan(0);

		const identity = repoIdentity(dir, "fixture");
		const latest = store.latestAuditRun(identity);
		expect(latest).not.toBeNull();
		expect(latest?.kind).toBe("sloppiness");
		expect(latest?.id).toBe(runId);
		expect(latest?.repoRoot).toBe(report.repo.root);
		expect(latest?.repoIdentity).toBe(identity);
		expect(latest?.sloppinessIndex).toBe(27);
		expect(latest?.partial).toBe(false);
		expect(latest?.completeness).toBe("complete");
		expect(latest?.reportJson).toBe(renderAuditJson(report));
		if (latest) expect(storedAuditReport(latest)).toEqual(report);
	});

	test("two audits with an equal payload at a pinned auditedAt persist identical JSON", () => {
		const report = makeAuditReport({ root: dir });
		const first = store.insertAuditRun(report);
		const second = store.insertAuditRun(report);
		expect(second).not.toBe(first);

		const runs = store.auditRuns(repoIdentity(dir, "fixture"));
		expect(runs).toHaveLength(2);
		expect(runs[0]?.reportJson).toBe(runs[1]?.reportJson);
	});

	test("auditRuns orders oldest-first and honors a since floor", () => {
		store.insertAuditRun(
			makeAuditReport({ root: dir, auditedAt: "2026-01-01T00:00:00.000Z", index: 30 }),
		);
		store.insertAuditRun(
			makeAuditReport({ root: dir, auditedAt: "2026-03-01T00:00:00.000Z", index: 20 }),
		);
		store.insertAuditRun(
			makeAuditReport({ root: dir, auditedAt: "2026-05-01T00:00:00.000Z", index: 10 }),
		);

		const identity = repoIdentity(dir, "fixture");
		expect(store.auditRuns(identity).map((r) => r.sloppinessIndex)).toEqual([30, 20, 10]);
		expect(
			store.auditRuns(identity, "2026-02-01T00:00:00.000Z").map((r) => r.sloppinessIndex),
		).toEqual([20, 10]);
	});

	test("auditRepos lists distinct identities with recorded audit runs, sorted", () => {
		expect(store.auditRepos()).toEqual([]);
		store.insertAuditRun(makeAuditReport({ root: join(dir, "b-repo") }));
		store.insertAuditRun(makeAuditReport({ root: join(dir, "a-repo") }));
		store.insertAuditRun(makeAuditReport({ root: join(dir, "b-repo") }));
		// Sorted by the full identity string (label#hash), not by path.
		const expected = [
			repoIdentity(join(dir, "a-repo"), "fixture"),
			repoIdentity(join(dir, "b-repo"), "fixture"),
		].sort();
		expect(store.auditRepos()).toEqual(expected);
	});

	test("reopening an existing DB preserves recorded audit runs", () => {
		store.insertAuditRun(makeAuditReport({ root: dir, index: 42 }));
		store.close();

		const reopened = openStore(join(dir, "trellis.db"));
		const latest = reopened.latestAuditRun(repoIdentity(dir, "fixture"));
		expect(latest?.sloppinessIndex).toBe(42);
		store = reopened; // hand back to afterEach for cleanup
	});
});

describe("compatible run selection", () => {
	let dir: string;
	let store: Store;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "trellis-compat-"));
		store = openStore(join(dir, "trellis.db"));
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	/**
	 * Simulate a foreign `audit_runs` row carrying a schema version this
	 * trellis can neither write nor read (a second raw connection to the
	 * same database — insertAuditRun validates, and trellis writes only
	 * versions it can read, §16.6): the read path must skip it, never
	 * silently trend it.
	 */
	function insertForeignSchemaRun(auditedAt: string, index: number): void {
		const db = new Database(join(dir, "trellis.db"));
		db.query(
			`INSERT INTO audit_runs
			 (repo_root, repo_identity, schema_version, analyzer_version, scoring_version,
			  sloppiness_index, partial, completeness, report_json, audited_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"/tmp/fixture",
			repoIdentity(dir, "fixture"),
			"0.0.0-legacy-schema",
			ANALYZER_VERSION,
			SCORING_VERSION,
			index,
			0,
			"complete",
			"{}",
			auditedAt,
		);
		db.close();
	}

	test("latestCompatibleRun skips newer runs with incompatible scored bases", () => {
		const current = makeAuditReport({ root: dir });
		const identity = repoIdentity(dir, "fixture");

		store.insertAuditRun(
			makeAuditReport({ root: dir, auditedAt: "2026-01-01T00:00:00.000Z", index: 30 }),
		);
		// Newer, but scored with a different formula — never a baseline candidate.
		store.insertAuditRun(
			makeAuditReport({
				root: dir,
				auditedAt: "2026-02-01T00:00:00.000Z",
				index: 1,
				scoringVersion: "9.9.9-experimental",
			}),
		);
		// Newer still, but from a different analyzer release.
		store.insertAuditRun(
			makeAuditReport({
				root: dir,
				auditedAt: "2026-03-01T00:00:00.000Z",
				index: 2,
				analyzerVersion: "0.0.0-ancient",
			}),
		);

		const prior = store.latestCompatibleRun(identity, current);
		expect(prior?.sloppinessIndex).toBe(30);
		expect(prior?.auditedAt).toBe("2026-01-01T00:00:00.000Z");
	});

	test("compatible trends contain only scored-basis-compatible runs, oldest first", () => {
		const current = makeAuditReport({ root: dir });
		const identity = repoIdentity(dir, "fixture");

		store.insertAuditRun(
			makeAuditReport({ root: dir, auditedAt: "2026-01-01T00:00:00.000Z", index: 30 }),
		);
		// Newer still, but carrying a schema version this trellis can neither
		// write nor read — a foreign row simulated with a direct insert
		// (insertAuditRun validates; trellis writes only versions it can
		// read, §16.6), never silently joined into a trend.
		insertForeignSchemaRun("2026-03-01T00:00:00.000Z", 99);
		store.insertAuditRun(
			makeAuditReport({ root: dir, auditedAt: "2026-04-01T00:00:00.000Z", index: 10 }),
		);

		const compatible = store.compatibleAuditRuns(identity, current);
		expect(compatible.map((r) => r.sloppinessIndex)).toEqual([30, 10]);

		const trend = store.sloppinessTrend(identity, current);
		expect(trend.map((p) => p.index)).toEqual([30, 10]);
		expect(trend.map((p) => p.auditedAt)).toEqual([
			"2026-01-01T00:00:00.000Z",
			"2026-04-01T00:00:00.000Z",
		]);
		expect(trend.every((p) => p.partial === false && p.completeness === "complete")).toBe(true);

		// The since floor applies to the compatible series too.
		expect(
			store.sloppinessTrend(identity, current, "2026-02-15T00:00:00.000Z").map((p) => p.index),
		).toEqual([10]);
	});

	test("legacy readiness runs and sloppiness runs never form a mixed trend", () => {
		// A legacy readiness run for the same repo label…
		store.insertRun({
			repo: "fixture",
			rubricVersion: "1.0.0",
			scoredAt: "2026-01-01T00:00:00.000Z",
			commit: "abc123",
			level: 3,
			passRate: 0.75,
			coverage: 0.9,
			apps: {},
			criteria: {},
		});
		// …and a sloppiness run for the same checkout.
		const report = makeAuditReport({ root: dir, index: 12 });
		store.insertAuditRun(report);
		const identity = repoIdentity(dir, "fixture");

		// The sloppiness trend sees only the sloppiness run — readiness never enters it.
		const trend = store.sloppinessTrend(identity, report);
		expect(trend).toHaveLength(1);
		expect(trend[0]?.index).toBe(12);

		// The legacy trend sees only the legacy run — sloppiness never enters it.
		expect(store.runs("fixture")).toHaveLength(1);
		expect(store.latestRun("fixture")?.kind).toBe("legacy-readiness");
		expect(store.latestAuditRun(identity)?.kind).toBe("sloppiness");
	});
});

describe("disabled persistence", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "trellis-nopersist-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("a fresh store records nothing until an insert is explicitly requested", () => {
		const store = openStore(join(dir, "trellis.db"));
		try {
			expect(store.auditRepos()).toEqual([]);
			expect(store.latestAuditRun(repoIdentity(dir))).toBeNull();
			expect(store.sloppinessTrend(repoIdentity(dir), makeAuditReport())).toEqual([]);
		} finally {
			store.close();
		}
	});

	test("the audit core runs with no store at all, and its report persists only on demand", async () => {
		// Seed a minimal clean workspace (same shape as the audit-core fixtures).
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(join(dir, "package.json"), JSON.stringify({ name: "fixture-nopersist" }));
		await writeFile(
			join(dir, "src", "alpha.ts"),
			"export function alpha(input: number): number {\n\tif (input > 0) {\n\t\treturn input * 2;\n\t}\n\treturn 0;\n}\n",
		);

		// No store is opened anywhere: the audit is stateless and zero-footprint.
		const report = await auditWorkspace(dir, { now: new Date("2026-06-06T00:00:00.000Z") });
		expect(report.repo.identity).toBe("fixture-nopersist");

		// Persisting is an explicit, separate step against a store the caller opened.
		const store = openStore(join(dir, ".trellis-history.db"));
		try {
			expect(store.auditRepos()).toEqual([]);
			store.insertAuditRun(report);
			const stored = store.latestAuditRun(repoIdentity(dir, "fixture-nopersist"));
			expect(stored).not.toBeNull();
			if (stored) expect(storedAuditReport(stored)).toEqual(report);
		} finally {
			store.close();
		}
	});
});
