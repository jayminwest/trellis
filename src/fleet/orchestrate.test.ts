import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	auditWorkspace,
	type WorkspaceAuditOptions,
	type WorkspaceAuditResult,
} from "../audit/index.ts";
import { measurementPayload } from "../contract/index.ts";
import { auditFixture, seedFixtureRepo } from "../report/audit-fixtures.ts";
import type { DriftReport } from "../standards/index.ts";
import { openStore, repoIdentity } from "../store/index.ts";
import { type FleetRunDeps, runFleet } from "./orchestrate.ts";
import { runFleetTargets } from "./run.ts";
import type { Fleet, ResolvedTarget } from "./targets.ts";

/** A fixed instant so every run's `auditedAt` is deterministic. */
const NOW = new Date("2026-06-06T00:00:00.000Z");

/** Build a resolved target (`absPath` defaults to `/abs/<id>`). */
function target(id: string, spec: Partial<ResolvedTarget["spec"]> = {}): ResolvedTarget {
	return { spec: { id, path: id, ...spec }, absPath: `/abs/${id}` };
}

/** Build a fleet with optional defaults. */
function fleet(targets: ResolvedTarget[], defaults: Fleet["defaults"] = {}): Fleet {
	return { defaults, targets, baseDir: "/base" };
}

/** A passing policy assessment shorthand. */
const PASS_POLICY: WorkspaceAuditResult["policy"] = { failed: false, results: [] };

/** A drift report with the given failing-state counts (other states zeroed). */
function driftReport(driftCount: number, missing: number): DriftReport {
	return {
		repo: "x",
		canonicalVersion: "1.0.0",
		files: [],
		summary: { match: 0, "allowed-delta": 0, drift: driftCount, missing, extra: 0 },
	};
}

describe("runFleet (stubbed seams)", () => {
	let fixture: Awaited<ReturnType<typeof auditFixture>>;
	beforeEach(async () => {
		fixture = await auditFixture("clean");
	});
	afterEach(async () => {
		await fixture.cleanup();
	});

	/** An audit stub returning the fixture report (policy overridable). */
	function stubAudit(
		policy: WorkspaceAuditResult["policy"] = PASS_POLICY,
	): (root: string, opts: WorkspaceAuditOptions) => Promise<WorkspaceAuditResult> {
		return async () => ({ report: fixture.report, policy });
	}

	/** Common deps: pinned clock, all paths present, drift stubbed clean. */
	function deps(over: Partial<FleetRunDeps> = {}): FleetRunDeps {
		return {
			now: NOW,
			pathExists: () => true,
			audit: stubAudit(),
			drift: () => driftReport(0, 0),
			...over,
		};
	}

	test("audits every target and aggregates the summary", async () => {
		const report = await runFleet(fleet([target("a"), target("b")]), deps());
		expect(report.entries.map((e) => e.id)).toEqual(["a", "b"]);
		expect(report.entries.every((e) => e.ok)).toBe(true);
		expect(report.summary).toEqual({ ok: 2, error: 0, policyFailed: 0 });
		expect(report.auditedAt).toBe(NOW.toISOString());
		// The entry preserves the whole report — findings and completeness intact.
		const entry = report.entries[0];
		expect(entry?.ok && entry.report).toEqual(fixture.report);
		expect(entry?.ok && entry.policy).toEqual(PASS_POLICY);
		expect(entry?.ok && entry.previousIndex).toBeNull();
		expect(entry?.ok && entry.indexDelta).toBeNull();
	});

	test("isolates a per-target audit failure without aborting the fleet", async () => {
		const audit = (async (_root: string, opts: WorkspaceAuditOptions) => {
			if (opts.configPath === "bad") throw new Error("invalid trellis.yaml: policy.maxIndex");
			return { report: fixture.report, policy: PASS_POLICY };
		}) satisfies FleetRunDeps["audit"] & object;
		const badTarget: ResolvedTarget = {
			spec: { id: "bad", path: "bad", config: "bad" },
			absPath: "/abs/bad",
			absConfigPath: "bad",
		};
		const report = await runFleet(
			fleet([target("ok1"), badTarget, target("ok2")]),
			deps({ audit }),
		);
		expect(report.summary).toEqual({ ok: 2, error: 1, policyFailed: 0 });
		const bad = report.entries.find((e) => e.id === "bad");
		expect(bad?.ok).toBe(false);
		expect(bad?.ok === false && bad.error).toMatch(/invalid trellis.yaml/);
	});

	test("reports a missing target path as a per-target error", async () => {
		const pathExists = (p: string) => p !== "/abs/gone";
		const report = await runFleet(fleet([target("here"), target("gone")]), deps({ pathExists }));
		const gone = report.entries.find((e) => e.id === "gone");
		expect(gone?.ok).toBe(false);
		expect(gone?.ok === false && gone.error).toMatch(/path not found/);
		expect(report.entries.find((e) => e.id === "here")?.ok).toBe(true);
	});

	test("counts a tripped declarative policy in the summary without failing the audit", async () => {
		const tripped = {
			failed: true,
			results: [
				{
					policy: "max-index" as const,
					status: "fail" as const,
					reasons: [{ code: "index-exceeds-max" as const, message: "index 12 exceeds max 0" }],
				},
			],
		};
		const report = await runFleet(fleet([target("a")]), deps({ audit: stubAudit(tripped) }));
		expect(report.summary).toEqual({ ok: 1, error: 0, policyFailed: 1 });
		const entry = report.entries[0];
		expect(entry?.ok && entry.policy.failed).toBe(true);
	});

	test("surfaces canonical-drift counts as a separate, non-scoring capability", async () => {
		const report = await runFleet(fleet([target("a")]), deps({ drift: () => driftReport(2, 1) }));
		const entry = report.entries[0];
		expect(entry?.ok && entry.drift).toEqual({
			match: 0,
			"allowed-delta": 0,
			drift: 2,
			missing: 1,
			extra: 0,
		});
		// Drift never touches the audit's score or policy.
		expect(entry?.ok && entry.report.score.index).toBe(fixture.report.score.index);
		expect(entry?.ok && entry.policy.failed).toBe(false);
	});

	test("a drift failure degrades to driftError on an otherwise healthy entry", async () => {
		const drift = () => {
			throw new Error("canonical version 9.9.9 is not bundled (have 1.0.0)");
		};
		const report = await runFleet(fleet([target("a")]), deps({ drift }));
		const entry = report.entries[0];
		expect(entry?.ok).toBe(true);
		expect(entry?.ok && entry.drift).toBeNull();
		expect(entry?.ok && entry.driftError).toMatch(/not bundled/);
		expect(entry?.ok && entry.report).toEqual(fixture.report);
	});

	test("passes the target's config path, history, db, and shared clock into the audit", async () => {
		const seen: WorkspaceAuditOptions[] = [];
		const audit = (async (_root: string, opts: WorkspaceAuditOptions) => {
			seen.push(opts);
			return { report: fixture.report, policy: PASS_POLICY };
		}) satisfies FleetRunDeps["audit"] & object;
		await runFleet(
			fleet([
				{
					spec: { id: "a", path: "a", config: "cfg.yaml" },
					absPath: "/abs/a",
					absConfigPath: "/base/cfg.yaml",
				},
			]),
			deps({ audit, history: true, db: "/tmp/fleet.db" }),
		);
		const opts = seen[0];
		expect(opts?.configPath).toBe("/base/cfg.yaml");
		expect(opts?.history).toBe(true);
		expect(opts?.db).toBe("/tmp/fleet.db");
		expect(opts?.now).toBe(NOW);
		// No investigation/readiness wiring remains on the audit path (SPEC §14).
		expect(opts && "investigation" in opts).toBe(false);
		expect(opts && "rubric" in opts).toBe(false);
	});

	test("computes the index delta against the stored baseline when history is on", async () => {
		const baseline = { ...fixture.report, score: { ...fixture.report.score, index: 9 } };
		const audit = (async () => ({
			report: fixture.report,
			policy: PASS_POLICY,
			baseline,
		})) satisfies FleetRunDeps["audit"] & object;
		const report = await runFleet(fleet([target("a")]), deps({ audit, history: true }));
		const entry = report.entries[0];
		expect(entry?.ok && entry.previousIndex).toBe(9);
		expect(entry?.ok && entry.indexDelta).toBe(fixture.report.score.index - 9);
	});
});

describe("runFleetTargets (real core, two-repository fixtures)", () => {
	let dir: string;
	let cleanRoot: string;
	let sloppyRoot: string;
	let dbPath: string;
	let targetsFile: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "trellis-fleet-core-"));
		cleanRoot = join(dir, "clean");
		sloppyRoot = join(dir, "sloppy");
		await seedFixtureRepo(cleanRoot, "clean");
		await seedFixtureRepo(sloppyRoot, "sloppy");
		dbPath = join(dir, "trellis.db");
		targetsFile = join(dir, "targets.yaml");
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	/** Write the fleet declaration for the two fixture repos (+ any extra targets). */
	async function writeTargets(extra = ""): Promise<void> {
		await writeFile(
			targetsFile,
			`targets:\n  - id: clean\n    path: ${cleanRoot}\n  - id: sloppy\n    path: ${sloppyRoot}\n${extra}`,
		);
	}

	test("fleet results match independent core audits and preserve findings/completeness", async () => {
		await writeTargets();
		const report = await runFleetTargets(targetsFile, { now: NOW });
		expect(report.summary).toEqual({ ok: 2, error: 0, policyFailed: 0 });

		for (const [id, root] of [
			["clean", cleanRoot],
			["sloppy", sloppyRoot],
		] as const) {
			const entry = report.entries.find((e) => e.id === id);
			expect(entry?.ok).toBe(true);
			if (entry?.ok !== true) continue;
			// One code path: the fleet entry's measurement payload deep-equals an
			// independent audit of the same workspace at the same pinned instant.
			const independent = await auditWorkspace(root, { now: NOW });
			expect(measurementPayload(entry.report)).toEqual(measurementPayload(independent));
			// Per-repository findings and completeness are preserved whole.
			expect(entry.report.findings).toEqual(independent.findings);
			expect(entry.report.completeness).toBe(independent.completeness);
		}
		const sloppy = report.entries.find((e) => e.id === "sloppy");
		expect(sloppy?.ok && sloppy.report.findings.length).toBeGreaterThan(0);
	});

	test("a failed target is isolated and the survivors still score", async () => {
		await writeTargets(`  - id: gone\n    path: ${join(dir, "missing")}\n`);
		const report = await runFleetTargets(targetsFile, { now: NOW });
		expect(report.summary).toEqual({ ok: 2, error: 1, policyFailed: 0 });
		const gone = report.entries.find((e) => e.id === "gone");
		expect(gone?.ok).toBe(false);
		expect(gone?.ok === false && gone.error).toMatch(/path not found/);
	});

	test("a target's declarative policy failure surfaces in the aggregate summary", async () => {
		await writeFile(join(sloppyRoot, "trellis.yaml"), "policy:\n  maxIndex: 0\n");
		await writeTargets();
		const report = await runFleetTargets(targetsFile, { now: NOW });
		expect(report.summary).toEqual({ ok: 2, error: 0, policyFailed: 1 });
		const sloppy = report.entries.find((e) => e.id === "sloppy");
		expect(sloppy?.ok && sloppy.policy.failed).toBe(true);
		const clean = report.entries.find((e) => e.id === "clean");
		expect(clean?.ok && clean.policy.failed).toBe(false);
	});

	test("canonical drift runs per target and cannot change the structural score", async () => {
		await writeTargets();
		const report = await runFleetTargets(targetsFile, { now: NOW });
		for (const entry of report.entries) {
			expect(entry.ok).toBe(true);
			if (entry.ok !== true) continue;
			// The fixture repos ship no canonical files — drift reports them missing…
			expect(entry.drift?.missing).toBeGreaterThan(0);
			// …and the sloppiness index is exactly what a drift-free core audit produces.
			const independent = await auditWorkspace(entry.path, { now: NOW });
			expect(entry.report.score.index).toBe(independent.score.index);
		}
	});

	test("history persists one audit run per target and resolves the stored baseline", async () => {
		await writeTargets();
		const first = await runFleetTargets(targetsFile, { now: NOW, history: true, db: dbPath });
		expect(first.entries.every((e) => e.ok && e.previousIndex === null)).toBe(true);

		const second = await runFleetTargets(targetsFile, { now: NOW, history: true, db: dbPath });
		for (const entry of second.entries) {
			expect(entry.ok).toBe(true);
			if (entry.ok !== true) continue;
			// Same workspace, same pinned instant ⇒ the index move is exactly zero.
			expect(entry.previousIndex).toBe(entry.report.score.index);
			expect(entry.indexDelta).toBe(0);
		}

		const store = openStore(dbPath);
		try {
			const identities = store.auditRepos();
			expect(identities).toHaveLength(2);
			expect(identities).toContain(repoIdentity(cleanRoot, "fixture-clean"));
			expect(identities).toContain(repoIdentity(sloppyRoot, "fixture-sloppy"));
		} finally {
			store.close();
		}
	});

	test("is stateless by default — no database is created", async () => {
		await writeTargets();
		await runFleetTargets(targetsFile, { now: NOW, db: undefined });
		const store = openStore(dbPath);
		try {
			expect(store.auditRepos()).toEqual([]);
		} finally {
			store.close();
		}
	});

	test("rejects db without history with an actionable error", async () => {
		await writeTargets();
		await expect(runFleetTargets(targetsFile, { db: dbPath })).rejects.toThrow(
			/db is meaningful only with history/,
		);
	});

	test("rejects retired readiness and investigation options actionably", async () => {
		await writeTargets();
		const legacy = { noCache: true } as unknown as Parameters<typeof runFleetTargets>[1];
		await expect(runFleetTargets(targetsFile, legacy)).rejects.toThrow(
			/option 'noCache' no longer exists/,
		);
		const readiness = { rubricVersion: "1.0.0" } as unknown as Parameters<
			typeof runFleetTargets
		>[1];
		await expect(runFleetTargets(targetsFile, readiness)).rejects.toThrow(
			/option 'rubricVersion' no longer exists/,
		);
		const failOn = { failOn: "gate" } as unknown as Parameters<typeof runFleetTargets>[1];
		await expect(runFleetTargets(targetsFile, failOn)).rejects.toThrow(
			/option 'failOn' no longer exists/,
		);
	});
});
