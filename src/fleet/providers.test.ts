/**
 * Fleet provider-scope tests (SPEC §11 + §16, plan `pl-43c5` step 20 —
 * trellis-f3e5). The fleet is a thin orchestrator: every target folds its own
 * `runWorkspaceAudit` call with its own configuration, so per-target provider
 * selection, staged views, scratch and evidence must be isolated by
 * construction. These tests prove that against the real core on real temp
 * workspaces:
 *
 * - a target requesting a provider carries its own namespaced evidence and
 *   still deep-equals an independent audit of the same workspace;
 * - a native-only target stays byte-identical to a native-only audit and is
 *   never affected by a neighbor's provider evidence, unavailability or
 *   failure (criterion: absence never erases evidence or moves a score);
 * - required-evidence policy failures and provider configuration errors roll
 *   up through the existing fleet 0/1/2 contract (`assessFleet`), drift
 *   staying separate;
 * - trellis-owned scratch is cleaned for every target even when another
 *   target fails (the fleet is sequential — bounded concurrency of one — so
 *   targets can never share or race on a scratch path);
 * - opt-in history keeps provider evidence advisory (step 8): adding a
 *   provider between recorded runs never fragments the compatible baseline.
 *
 * The pinned-jscpd cases skip (never fabricate) where the pinned tool is not
 * installed on the host; the located-`unsupported` SonarJS capability covers
 * the evidence-carrying paths on every host.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkspaceAudit } from "../audit/index.ts";
import {
	providerEntry,
	seedClonePair,
	stagedScratchCount,
	TOOL_AVAILABLE,
} from "../audit/provider-fixtures.ts";
import { loadAuditConfig } from "../config/index.ts";
import { carriedAnalyses, measurementPayload } from "../contract/index.ts";
import { assessFleet } from "./assess.ts";
import type { FleetReport } from "./orchestrate.ts";
import { runFleetTargets } from "./run.ts";

/** A fixed instant so fleet and standalone runs compare deterministically. */
const NOW = new Date("2026-06-06T00:00:00.000Z");

/** Seed one clone-pair workspace under `dir` named `id`, optionally with config yaml. */
async function seedTarget(dir: string, id: string, yaml?: string): Promise<string> {
	const root = join(dir, id);
	await seedClonePair(root);
	if (yaml !== undefined) await writeFile(join(root, "trellis.yaml"), yaml);
	return root;
}

describe("runFleetTargets (per-target provider scope, real core)", () => {
	let dir: string;
	let targetsFile: string;
	let dbPath: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "trellis-fleet-providers-"));
		targetsFile = join(dir, "targets.yaml");
		dbPath = join(dir, "trellis.db");
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	/** Declare the fleet over the given `id: root` targets, in order. */
	async function declareFleet(targets: readonly [string, string][]): Promise<void> {
		const lines = targets.map(([id, root]) => `  - id: ${id}\n    path: ${root}\n`);
		await writeFile(targetsFile, `targets:\n${lines.join("")}`);
	}

	/** The ok entry `id`, failing fast when the target did not audit. */
	function okEntry(report: FleetReport, id: string) {
		const entry = report.entries.find((e) => e.id === id);
		if (entry?.ok !== true) throw new Error(`expected target "${id}" to audit`);
		return entry;
	}

	test("a provider target keeps its own evidence; a native-only neighbor stays native", async () => {
		const gated = await seedTarget(dir, "gated", "providers:\n  sonarjs: {}\n");
		const native = await seedTarget(dir, "native");
		await declareFleet([
			["gated", gated],
			["native", native],
		]);

		const before = await stagedScratchCount();
		const report = await runFleetTargets(targetsFile, { now: NOW });
		expect(report.summary).toEqual({ ok: 2, error: 0, policyFailed: 0 });
		// Optional absence is never a policy failure and never a fleet abort.
		expect(assessFleet(report).failed).toBe(false);

		// The requesting target carries its own located unsupported evidence…
		const gatedEntry = okEntry(report, "gated");
		const gatedAnalysis = providerEntry(gatedEntry.report, "sonarjs");
		expect(gatedAnalysis.state).toBe("unsupported");
		expect(gatedAnalysis.reason).toMatch(/deferred/);
		// …and still deep-equals an independent audit of the same workspace.
		const gatedStandalone = await runWorkspaceAudit(gated, { now: NOW });
		expect(measurementPayload(gatedEntry.report)).toEqual(
			measurementPayload(gatedStandalone.report),
		);
		expect(gatedEntry.policy).toEqual(gatedStandalone.policy);
		// Provider evidence is unscored: the index is exactly a native-only
		// audit of the same workspace (the selection block dropped).
		const gatedBase = await loadAuditConfig(gated);
		const gatedNative = await runWorkspaceAudit(gated, {
			config: { ...gatedBase, providers: {} },
			now: NOW,
		});
		expect(gatedEntry.report.score.index).toBe(gatedNative.report.score.index);

		// The native-only neighbor carries no external analysis at all and is
		// byte-identical to a native-only standalone audit — a neighbor's
		// evidence never leaks in, and its absence never moves the score.
		const nativeEntry = okEntry(report, "native");
		const nativeStandalone = await runWorkspaceAudit(native, { now: NOW });
		expect(measurementPayload(nativeEntry.report)).toEqual(
			measurementPayload(nativeStandalone.report),
		);
		expect(
			carriedAnalyses(nativeEntry.report).filter((a) => a.provider.kind === "external"),
		).toEqual([]);

		// No target staged anything it did not clean (the gated capability runs
		// nothing; the run is no-write for every target that did not ask).
		expect(await stagedScratchCount()).toBe(before);
	});

	test.skipIf(!TOOL_AVAILABLE)(
		"a jscpd target keeps complete evidence and provenance while its neighbor stays native",
		async () => {
			const cloned = await seedTarget(dir, "cloned", "providers:\n  jscpd:\n    mode: exact\n");
			const native = await seedTarget(dir, "native");
			await declareFleet([
				["cloned", cloned],
				["native", native],
			]);

			const before = await stagedScratchCount();
			const report = await runFleetTargets(targetsFile, { now: NOW });
			expect(report.summary).toEqual({ ok: 2, error: 0, policyFailed: 0 });

			// The requesting target carries complete, advisory, namespaced evidence
			// with its own provenance and asserted observed coverage…
			const clonedEntry = okEntry(report, "cloned");
			const analysis = providerEntry(clonedEntry.report, "jscpd");
			expect(analysis.state).toBe("complete");
			expect(analysis.scoring).toBe("advisory");
			expect(analysis.provider.mode).toBe("exact");
			expect(analysis.provider.toolVersion).not.toBe("0.0.0");
			expect(analysis.observedCoverage?.analyzedFiles.length).toBeGreaterThan(0);
			// …and equals an independent audit of the same workspace.
			const standalone = await runWorkspaceAudit(cloned, { now: NOW });
			expect(measurementPayload(clonedEntry.report)).toEqual(measurementPayload(standalone.report));
			expect(clonedEntry.policy).toEqual(standalone.policy);
			// Unscored: the provider request never moved the structural score —
			// the index is exactly a native-only audit of the same workspace.
			const base = await loadAuditConfig(cloned);
			const nativeOnly = await runWorkspaceAudit(cloned, {
				config: { ...base, providers: {} },
				now: NOW,
			});
			expect(clonedEntry.report.score.index).toBe(nativeOnly.report.score.index);

			// The neighbor stays byte-identical to a native-only audit.
			const nativeEntry = okEntry(report, "native");
			const nativeStandalone = await runWorkspaceAudit(native, { now: NOW });
			expect(measurementPayload(nativeEntry.report)).toEqual(
				measurementPayload(nativeStandalone.report),
			);

			// Trellis-owned scratch was cleaned for the provider target.
			expect(await stagedScratchCount()).toBe(before);
		},
		20_000,
	);

	test("required provider evidence fails the target's policy, not the fleet's scores", async () => {
		const required = await seedTarget(
			dir,
			"required",
			"policy:\n  requireEvidence: [sonarjs]\nproviders:\n  sonarjs: {}\n",
		);
		const native = await seedTarget(dir, "native");
		await declareFleet([
			["required", required],
			["native", native],
		]);

		const report = await runFleetTargets(targetsFile, { now: NOW });
		// The required target audited fine; its declarative policy tripped closed.
		expect(report.summary).toEqual({ ok: 2, error: 0, policyFailed: 1 });
		const requiredEntry = okEntry(report, "required");
		expect(requiredEntry.policy.failed).toBe(true);
		const reason = requiredEntry.policy.results.find((r) => r.status === "fail")?.reasons[0];
		expect(reason?.code).toBe("requirement-evidence-unsupported");
		// The rollup names the target and the tripped code (exit 2, SPEC §9).
		const assessment = assessFleet(report);
		expect(assessment.failed).toBe(true);
		expect(assessment.reasons.join(" ")).toContain("required: policy failed");
		expect(assessment.reasons.join(" ")).toContain('required analysis "sonarjs" is unsupported');
		// The native neighbor is untouched: its score and policy stand.
		const nativeEntry = okEntry(report, "native");
		expect(nativeEntry.policy.failed).toBe(false);
		const nativeStandalone = await runWorkspaceAudit(native, { now: NOW });
		expect(measurementPayload(nativeEntry.report)).toEqual(
			measurementPayload(nativeStandalone.report),
		);
	});

	test("a required analysis the run never requested fails closed per target", async () => {
		const required = await seedTarget(dir, "required", "policy:\n  requireEvidence: [jscpd]\n");
		await declareFleet([["required", required]]);
		const report = await runFleetTargets(targetsFile, { now: NOW });
		expect(report.summary).toEqual({ ok: 1, error: 0, policyFailed: 1 });
		const entry = okEntry(report, "required");
		const reason = entry.policy.results.find((r) => r.status === "fail")?.reasons[0];
		expect(reason?.code).toBe("requirement-analysis-unrequested");
		expect(reason?.message).toContain("the run did not request it");
	});

	test("one target's invalid provider configuration is an isolated operational error", async () => {
		const broken = await seedTarget(dir, "broken", "providers:\n  frobnicator: {}\n");
		const native = await seedTarget(dir, "native");
		const gated = await seedTarget(dir, "gated", "providers:\n  sonarjs: {}\n");
		await declareFleet([
			["broken", broken],
			["native", native],
			["gated", gated],
		]);

		const before = await stagedScratchCount();
		const report = await runFleetTargets(targetsFile, { now: NOW });
		// The invalid config is a per-target operational failure (an error
		// entry, exit-2 territory) — never an abort of the fleet.
		expect(report.summary).toEqual({ ok: 2, error: 1, policyFailed: 0 });
		const brokenEntry = report.entries.find((e) => e.id === "broken");
		expect(brokenEntry?.ok).toBe(false);
		expect(brokenEntry?.ok === false && brokenEntry.error).toMatch(/frobnicator/);
		// The survivors still score and keep their own evidence scope.
		const gatedEntry = okEntry(report, "gated");
		expect(providerEntry(gatedEntry.report, "sonarjs").state).toBe("unsupported");
		const nativeStandalone = await runWorkspaceAudit(native, { now: NOW });
		expect(measurementPayload(okEntry(report, "native").report)).toEqual(
			measurementPayload(nativeStandalone.report),
		);
		// The failing neighbor cost no scratch: every staged view was cleaned.
		expect(await stagedScratchCount()).toBe(before);
	});

	test.skipIf(!TOOL_AVAILABLE)(
		"scratch is cleaned for the provider target even when another target fails",
		async () => {
			const broken = await seedTarget(dir, "broken", "providers:\n  frobnicator: {}\n");
			const cloned = await seedTarget(
				dir,
				"cloned",
				"providers:\n  jscpd:\n    mode: normalized\n",
			);
			await declareFleet([
				["broken", broken],
				["cloned", cloned],
			]);
			const before = await stagedScratchCount();
			const report = await runFleetTargets(targetsFile, { now: NOW });
			expect(report.summary).toEqual({ ok: 1, error: 1, policyFailed: 0 });
			expect(providerEntry(okEntry(report, "cloned").report, "jscpd").state).toBe("complete");
			// The staged view the surviving target actually used is gone.
			expect(await stagedScratchCount()).toBe(before);
		},
		20_000,
	);

	test("history keeps provider evidence advisory: adding a provider never fragments the baseline", async () => {
		const repo = await seedTarget(dir, "repo");
		await declareFleet([["repo", repo]]);

		// First recorded run: native-only.
		const first = await runFleetTargets(targetsFile, { now: NOW, history: true, db: dbPath });
		expect(okEntry(first, "repo").previousIndex).toBeNull();

		// Second recorded run: the same workspace now requests the deferred
		// capability — an advisory evidence change, never a scored-basis
		// change, so the compatible baseline still resolves (step 8).
		await writeFile(join(repo, "trellis.yaml"), "providers:\n  sonarjs: {}\n");
		const second = await runFleetTargets(targetsFile, { now: NOW, history: true, db: dbPath });
		const entry = okEntry(second, "repo");
		expect(providerEntry(entry.report, "sonarjs").state).toBe("unsupported");
		expect(entry.previousIndex).toBe(okEntry(first, "repo").report.score.index);
		expect(entry.indexDelta).toBe(0);
	});
});
