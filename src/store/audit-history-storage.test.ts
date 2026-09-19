/**
 * Audit-history storage-boundary tests (plan `pl-43c5` step 8,
 * trellis-ab01) — history over **shared storage**: raw foreign rows (corrupt
 * or undecodable JSON) never silently imply external-measurement
 * compatibility, distinct repository identities keep separate histories, and
 * a real pre-existing database file — written exactly the way the
 * pre-step-8 code wrote it — keeps loading and trending in place with no
 * rewrite. Real temp-file SQLite, no mocks.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	evidenceReport,
	jscpdAnalysis,
	nativeComplexityAnalysis,
	preProviderReport,
} from "../compare/fixtures.ts";
import { ANALYZER_VERSION, type AuditReport, auditReportSchema } from "../contract/index.ts";
import { renderAuditJson } from "../report/audit-json.ts";
import { openStore, repoIdentity, type Store } from "./index.ts";

/** Root a fixture report at a real directory with a pinned identity and audit time. */
function rooted(report: AuditReport, root: string, auditedAt: string): AuditReport {
	return auditReportSchema.parse({
		...report,
		repo: { root, identity: "history-fixture" },
		run: { auditedAt },
	});
}

/** The repository identity a rooted report persists under. */
function identityOf(report: AuditReport): string {
	return repoIdentity(report.repo.root, report.repo.identity);
}

describe("audit history over shared storage", () => {
	let dir: string;
	let store: Store;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "trellis-audit-shared-"));
		store = openStore(join(dir, "trellis.db"));
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	/**
	 * Insert a raw `audit_runs` row the way a foreign writer might: no
	 * validation, and version columns that look perfectly compatible — the
	 * stored JSON, not the columns, must decide compatibility.
	 */
	function insertRawRun(reportJson: string, auditedAt: string, index: number): void {
		const db = new Database(join(dir, "trellis.db"));
		db.query(
			`INSERT INTO audit_runs
			 (repo_root, repo_identity, schema_version, analyzer_version, scoring_version,
			  sloppiness_index, partial, completeness, report_json, audited_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			dir,
			repoIdentity(dir, "history-fixture"),
			"1.1.0",
			ANALYZER_VERSION,
			"0.2.0-provisional",
			index,
			0,
			"complete",
			reportJson,
			auditedAt,
		);
		db.close();
	}

	test("foreign or corrupt newest rows never silently become compatible", () => {
		const good = rooted(
			evidenceReport([nativeComplexityAnalysis()], { index: 30 }),
			dir,
			"2026-07-01T00:00:00.000Z",
		);
		store.insertAuditRun(good);
		// A newer row whose JSON is not even parseable…
		insertRawRun("}{ not json", "2026-07-02T00:00:00.000Z", 2);
		// …and a newest row whose JSON parses but is not a §6.4 report.
		insertRawRun(
			'{"schemaVersion":"1.1.0","analyzerVersion":"0.0.0"}',
			"2026-07-03T00:00:00.000Z",
			3,
		);

		const identity = repoIdentity(dir, "history-fixture");
		const reference = rooted(
			evidenceReport([nativeComplexityAnalysis()], { index: 20 }),
			dir,
			"2026-07-04T00:00:00.000Z",
		);

		// Unknown provenance reads as absent: the series keeps only the
		// decodable, scored-basis-compatible run…
		expect(
			store.compatibleAuditRuns(identity, reference).map((run) => run.sloppinessIndex),
		).toEqual([30]);
		// …and the baseline walk skips both foreign rows back to the good one.
		const prior = store.latestCompatibleRun(identity, reference);
		expect(prior?.sloppinessIndex).toBe(30);
		expect(prior?.auditedAt).toBe("2026-07-01T00:00:00.000Z");
	});

	test("distinct repository identities keep separate histories", () => {
		const roots = [join(dir, "a", "repo"), join(dir, "b", "repo")] as const;
		for (const root of roots) mkdirSync(root, { recursive: true });
		const first = rooted(
			evidenceReport([nativeComplexityAnalysis()], { index: 10 }),
			roots[0],
			"2026-07-01T00:00:00.000Z",
		);
		const second = rooted(
			evidenceReport([nativeComplexityAnalysis()], { index: 20 }),
			roots[1],
			"2026-07-01T00:00:00.000Z",
		);
		store.insertAuditRun(first);
		store.insertAuditRun(second);

		// Same basename, different checkouts: the identities (label#hash)
		// differ, so each series sees exactly its own repo's runs.
		const identities = store.auditRepos();
		expect(identities).toHaveLength(2);
		expect(new Set(identities).size).toBe(2);
		for (const report of [first, second]) {
			expect(
				store.compatibleAuditRuns(identityOf(report), report).map((run) => run.sloppinessIndex),
			).toEqual([report.score.index]);
		}
	});
});

describe("a pre-existing history database", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "trellis-audit-preexisting-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("rows persisted before the provider plan keep loading and trending in place", () => {
		const dbPath = join(dir, "trellis.db");
		const root = join(dir, "workspace");
		mkdirSync(root, { recursive: true });
		// Simulate the on-disk state exactly as the pre-step-8 code left it:
		// rows written through the same renderAuditJson bytes.
		const db = new Database(dbPath);
		db.exec(readFileSync(join(import.meta.dir, "migrations", "0002-audit-runs.sql"), "utf8"));
		db.exec("PRAGMA user_version = 2");
		const identity = repoIdentity(root, "history-fixture");
		const insertAudit = (report: AuditReport): void => {
			db.query(
				`INSERT INTO audit_runs
				 (repo_root, repo_identity, schema_version, analyzer_version, scoring_version,
				  sloppiness_index, partial, completeness, report_json, audited_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				report.repo.root,
				identity,
				report.schemaVersion,
				report.analyzerVersion,
				report.scoringVersion,
				report.score.index,
				report.score.partial ? 1 : 0,
				report.completeness,
				renderAuditJson(report),
				report.run?.auditedAt ?? "",
			);
		};
		insertAudit(
			rooted(preProviderReport(undefined, { index: 40 }), root, "2026-07-01T00:00:00.000Z"),
		);
		insertAudit(
			rooted(
				evidenceReport([nativeComplexityAnalysis()], { index: 30, schemaVersion: "1.1.0" }),
				root,
				"2026-07-02T00:00:00.000Z",
			),
		);
		db.close();

		// Reopen with the current code: no migration, no rewrite — the rows
		// load and trend under the scored-basis selection as they were stored.
		const store = openStore(dbPath);
		try {
			const probe = new Database(dbPath, { readonly: true });
			const version = probe.query<{ user_version: number }, []>("PRAGMA user_version").get();
			probe.close();
			expect(version?.user_version).toBe(2);
			expect(store.auditRuns(identity)).toHaveLength(2);
			const current = rooted(
				evidenceReport([jscpdAnalysis(), nativeComplexityAnalysis()], {
					index: 25,
					schemaVersion: "1.1.0",
				}),
				root,
				"2026-07-03T00:00:00.000Z",
			);
			expect(
				store.compatibleAuditRuns(identity, current).map((run) => run.sloppinessIndex),
			).toEqual([40, 30]);
		} finally {
			store.close();
		}
	});
});
