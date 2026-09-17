import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jscpdAnalysis } from "../compare/fixtures.ts";
import { ReportArtifactError } from "../compare/index.ts";
import {
	type AuditReport,
	auditReportSchema,
	type EvidenceArea,
	SCHEMA_VERSION,
} from "../contract/index.ts";
import { LegacyConfigError } from "../legacy.ts";
import { seedFixtureRepo } from "../report/audit-fixtures.ts";
import { renderAuditJson } from "../report/audit-json.ts";
import { openStore } from "../store/index.ts";
import { AuditRunError, runWorkspaceAudit, type WorkspaceAuditOptions } from "./run.ts";

/**
 * The audit run service (SPEC §12, §13.1, trellis-9a88): the composition the
 * CLI and SDK both fold. These tests pin the contract the surfaces rely on —
 * stateless-by-default (no database, no files), opt-in history with a stored
 * baseline, explicit baseline artifacts, declarative policy assessment, and
 * actionable rejection of retired knobs. Real temp workspaces seeded through
 * the shared render fixtures; real SQLite in temp dirs.
 */

let root: string;
let dbDir: string;

/** The evidence area of a real audit's report (always schema 1.1.0, trellis-a24d). */
function evidenceAreaOf(report: AuditReport): EvidenceArea {
	if (report.schemaVersion !== SCHEMA_VERSION) {
		throw new Error("expected an evidence-carrying (schema 1.1.0) report");
	}
	return report.evidence;
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "trellis-run-"));
	dbDir = await mkdtemp(join(tmpdir(), "trellis-run-db-"));
	// A non-Git workspace with one branchy function — a guaranteed non-zero index.
	await seedFixtureRepo(root, "sloppy");
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
	await rm(dbDir, { recursive: true, force: true });
});

describe("runWorkspaceAudit", () => {
	test("audits a non-Git workspace with no credentials, tools, or writes (SPEC §8)", async () => {
		const dbPath = join(dbDir, "trellis.db");
		const previousDb = process.env.TRELLIS_DB;
		process.env.TRELLIS_DB = dbPath;
		try {
			const result = await runWorkspaceAudit(root);
			expect(result.report.schemaVersion).toBeDefined();
			expect(result.report.score.index).toBeGreaterThan(0);
			expect(result.policy.failed).toBe(false);
			expect(result.baseline).toBeUndefined();
			expect(result.historyRunId).toBeUndefined();
			// Stateless: no database was opened and the workspace gained no files.
			expect(existsSync(dbPath)).toBe(false);
			expect(existsSync(join(root, ".trellis"))).toBe(false);
		} finally {
			if (previousDb === undefined) delete process.env.TRELLIS_DB;
			else process.env.TRELLIS_DB = previousDb;
		}
	});

	test("db without history is an operational error", async () => {
		await expect(runWorkspaceAudit(root, { db: join(dbDir, "x.db") })).rejects.toThrow(
			AuditRunError,
		);
		await expect(runWorkspaceAudit(root, { db: join(dbDir, "x.db") })).rejects.toThrow(
			/meaningful only with history/,
		);
	});

	test("config and configPath are mutually exclusive", async () => {
		const opts = {
			config: {
				source: { exclude: [], classify: {} },
				providers: {},
				policy: { budgets: {}, failOnNew: [], requireEvidence: [] },
			},
			configPath: join(root, "trellis.yaml"),
		} satisfies WorkspaceAuditOptions;
		await expect(runWorkspaceAudit(root, opts)).rejects.toThrow(/at most one of config/);
	});

	test("an explicit --config file gates the run (declarative policy, SPEC §6.5)", async () => {
		const configPath = join(dbDir, "trellis.yaml");
		await writeFile(configPath, "policy:\n  maxIndex: 0\n");
		const result = await runWorkspaceAudit(root, { configPath });
		expect(result.policy.failed).toBe(true);
		const failed = result.policy.results.find((r) => r.status === "fail");
		expect(failed?.policy).toBe("max-index");
		expect(failed?.reasons[0]?.code).toBe("index-exceeds-max");
	});

	test("an invalid --config file is an operational error naming the key", async () => {
		const configPath = join(dbDir, "trellis.yaml");
		await writeFile(configPath, "policy:\n  maxIndex: 400\n");
		await expect(runWorkspaceAudit(root, { configPath })).rejects.toThrow(/policy\.maxIndex/);
	});

	test("a missing --config file is an operational error", async () => {
		await expect(
			runWorkspaceAudit(root, { configPath: join(dbDir, "absent.yaml") }),
		).rejects.toThrow(/cannot read config file/);
	});

	test("an explicit baseline artifact drives the regression policy (SPEC §9)", async () => {
		// Baseline the workspace clean, then re-seed it sloppy: a guaranteed regression.
		await rm(root, { recursive: true, force: true });
		root = await mkdtemp(join(tmpdir(), "trellis-run-"));
		await seedFixtureRepo(root, "clean");
		const first = await runWorkspaceAudit(root);
		expect(first.report.score.index).toBe(0);
		const baselinePath = join(dbDir, "baseline.json");
		await writeFile(baselinePath, renderAuditJson(first.report));
		await seedFixtureRepo(root, "sloppy");
		const configPath = join(dbDir, "trellis.yaml");
		await writeFile(configPath, "policy:\n  regression: {}\n");
		const result = await runWorkspaceAudit(root, { configPath, baselinePath });
		expect(result.baseline?.score.index).toBe(first.report.score.index);
		expect(result.policy.failed).toBe(true);
		const regression = result.policy.results.find((r) => r.policy === "score-regression");
		expect(regression?.status).toBe("fail");
		expect(regression?.reasons[0]?.code).toBe("regression-exceeds-absolute");
	});

	test("an unloadable baseline artifact is an operational error, never a policy failure", async () => {
		await expect(
			runWorkspaceAudit(root, { baselinePath: join(dbDir, "absent.json") }),
		).rejects.toThrow(ReportArtifactError);
	});

	test("history persists the run and supplies the next run's baseline (SPEC §10)", async () => {
		const dbPath = join(dbDir, "trellis.db");
		const first = await runWorkspaceAudit(root, { history: true, db: dbPath });
		expect(first.historyRunId).toBeDefined();
		expect(first.baseline).toBeUndefined(); // a first run has nothing to regress against
		expect(existsSync(dbPath)).toBe(true);

		const second = await runWorkspaceAudit(root, { history: true, db: dbPath });
		expect(second.baseline?.score.index).toBe(first.report.score.index);
		expect(second.historyRunId).toBeDefined();
		expect(second.historyRunId).not.toBe(first.historyRunId);

		const store = openStore(dbPath);
		try {
			expect(store.auditRepos()).toHaveLength(1);
		} finally {
			store.close();
		}
	});

	test("an advisory provider change between stored runs never fragments the baseline", async () => {
		const dbPath = join(dbDir, "trellis.db");
		const first = await runWorkspaceAudit(root); // stateless: just the report
		// A prior stored run carrying advisory jscpd evidence alongside the
		// same native scored analyses — the shape step 15 will record.
		const area = evidenceAreaOf(first.report);
		const advisory = auditReportSchema.parse({
			...first.report,
			evidence: {
				...area,
				analyses: [...area.analyses, jscpdAnalysis()].sort((a, b) =>
					a.provider.id.localeCompare(b.provider.id),
				),
			},
			run: { auditedAt: "2026-08-01T00:00:00.000Z" },
		});
		const seed = openStore(dbPath);
		try {
			seed.insertAuditRun(advisory);
		} finally {
			seed.close();
		}

		const second = await runWorkspaceAudit(root, { history: true, db: dbPath });
		// The advisory difference never fragments the scored basis: the stored
		// run is still the baseline (AC2), re-read from its stored provenance.
		expect(second.baseline).toEqual(advisory);
		expect(second.historyRunId).toBeDefined();
	});

	test("a changed scored measurement starts a distinct series — no stored baseline", async () => {
		const dbPath = join(dbDir, "trellis.db");
		const first = await runWorkspaceAudit(root);
		// A prior stored run whose scored native analysis recorded a different
		// pinned tool: same core versions, a different scored measurement.
		const scored = evidenceAreaOf(first.report).analyses.find(
			(analysis) => analysis.scoring === "scored" && analysis.provider.kind === "native",
		);
		if (scored === undefined) throw new Error("fixture report must carry a scored native analysis");
		const area = evidenceAreaOf(first.report);
		const altered = auditReportSchema.parse({
			...first.report,
			evidence: {
				...area,
				analyses: area.analyses.map((analysis) =>
					analysis === scored
						? {
								...analysis,
								provider: { ...analysis.provider, toolVersion: "9.9.9-altered" },
							}
						: analysis,
				),
			},
			run: { auditedAt: "2026-08-01T00:00:00.000Z" },
		});
		const seed = openStore(dbPath);
		try {
			seed.insertAuditRun(altered);
		} finally {
			seed.close();
		}

		const second = await runWorkspaceAudit(root, { history: true, db: dbPath });
		// Incompatible scored bases never become one trend: no baseline is
		// resolved across the changed measurement, so baseline-dependent
		// policies skip rather than compare a false regression.
		expect(second.baseline).toBeUndefined();
		expect(second.historyRunId).toBeDefined();
	});

	test("an explicit baseline wins over the stored history baseline", async () => {
		const dbPath = join(dbDir, "trellis.db");
		await runWorkspaceAudit(root, { history: true, db: dbPath });
		const other = await mkdtemp(join(tmpdir(), "trellis-run-other-"));
		try {
			await seedFixtureRepo(other, "clean");
			const clean = await runWorkspaceAudit(other);
			const baselinePath = join(dbDir, "clean.json");
			await writeFile(baselinePath, renderAuditJson(clean.report));
			const result = await runWorkspaceAudit(root, { history: true, db: dbPath, baselinePath });
			expect(result.baseline?.score.index).toBe(clean.report.score.index);
		} finally {
			await rm(other, { recursive: true, force: true });
		}
	});

	test("baseline-dependent policies skip (never fail) on a first run without a baseline", async () => {
		const configPath = join(dbDir, "trellis.yaml");
		await writeFile(configPath, "policy:\n  regression: {}\n  failOnNew:\n    - import-cycle\n");
		const result = await runWorkspaceAudit(root, { configPath });
		expect(result.policy.failed).toBe(false);
		const skipped = result.policy.results.filter((r) => r.status === "skipped");
		expect(skipped.length).toBe(2);
		expect(skipped.every((r) => r.reasons[0]?.code === "baseline-absent")).toBe(true);
	});

	test("retired investigation options are rejected actionably", async () => {
		const legacy = { piBin: "pi" } as unknown as WorkspaceAuditOptions;
		await expect(runWorkspaceAudit(root, legacy)).rejects.toThrow(LegacyConfigError);
		await expect(runWorkspaceAudit(root, legacy)).rejects.toThrow(
			/option 'piBin' no longer exists/,
		);
	});

	test("retired readiness options are rejected actionably", async () => {
		for (const key of ["rubricVersion", "minLevel", "failOn", "canonical", "persist"]) {
			const legacy = { [key]: "x" } as unknown as WorkspaceAuditOptions;
			await expect(runWorkspaceAudit(root, legacy)).rejects.toThrow(AuditRunError);
			await expect(runWorkspaceAudit(root, legacy)).rejects.toThrow(
				new RegExp(`option '${key}' no longer exists`),
			);
		}
	});
});
