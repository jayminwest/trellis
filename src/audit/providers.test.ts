import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuditConfig, auditReportSchema, measurementPayload } from "../contract/index.ts";
import { discoverSourceInventory, type SourceInventory } from "../discovery/index.ts";
import { auditWorkspace } from "./audit.ts";
import {
	carriedProviderIds,
	evidenceArea,
	PINNED,
	providerAuditConfig,
	providerEntry,
	putFile,
	seedClonePair,
	stagedScratchCount,
	TINY_FN,
	TOOL_AVAILABLE,
} from "./provider-fixtures.ts";
import {
	type ProviderAnalysisPlanEntry,
	providerExecutionPlan,
	runProviderAnalyses,
} from "./providers.ts";

/**
 * Declarative provider selection through the core (SPEC §16.3–16.5, plan
 * pl-43c5 step 15 — trellis-15e3): the default selects only native analyses
 * and stays byte-identical; a requested jscpd adds unscored advisory
 * evidence beside the native duplication result; failures stay located
 * evidence; cancellation and cleanup propagate. Policy-over-evidence cases
 * live in `provider-policy.test.ts`; shared fixtures in
 * `provider-fixtures.ts`.
 */

let repo: string;

beforeEach(async () => {
	repo = await mkdtemp(join(tmpdir(), "trellis-providers-"));
});

afterEach(async () => {
	await rm(repo, { recursive: true, force: true });
});

/** The discovered inventory of the temp repo (an actual file inventory). */
async function inventory(): Promise<SourceInventory> {
	return discoverSourceInventory(repo);
}

/** A jscpd request selection. */
const jscpd = (mode: "exact" | "normalized" | "near"): AuditConfig["providers"] => ({
	jscpd: { mode },
});

describe("providerExecutionPlan", () => {
	test("translates the declarative selection deterministically, sorted by provider id", () => {
		const plan = providerExecutionPlan(
			providerAuditConfig({ jscpd: { mode: "near" }, sonarjs: {}, knip: {} }),
		);
		const expected: ProviderAnalysisPlanEntry[] = [
			{ providerId: "jscpd", mode: "near" },
			{ providerId: "knip" },
			{ providerId: "sonarjs" },
		];
		expect(plan).toEqual(expected);
		expect(providerExecutionPlan(providerAuditConfig({}))).toEqual([]);
		const near = providerAuditConfig(jscpd("near"));
		expect(providerExecutionPlan(near)).toEqual(providerExecutionPlan(near));
	});
});

describe("default configuration selects only native analyses", () => {
	test("an absent and an empty providers block produce byte-identical native reports", async () => {
		await seedClonePair(repo);
		const absent = await auditWorkspace(repo, { now: PINNED });
		const empty = await auditWorkspace(repo, {
			config: providerAuditConfig({}),
			now: PINNED,
		});
		expect(measurementPayload(empty)).toEqual(measurementPayload(absent));
		// No provider is carried: absence reads as unrequested (§6.6).
		expect(carriedProviderIds(absent)).toEqual([
			"trellis.complexity",
			"trellis.dependency-graph",
			"trellis.duplication",
			"trellis.import-cycles",
		]);
		expect(evidenceArea(absent).completeness).toBe("complete");
	});

	test("a default audit creates no scratch and launches nothing", async () => {
		await seedClonePair(repo);
		const before = await stagedScratchCount();
		const report = await auditWorkspace(repo, { now: PINNED });
		expect(carriedProviderIds(report)).toHaveLength(4);
		expect(await stagedScratchCount()).toBe(before);
	});
});

describe("an explicitly requested jscpd adds unscored advisory evidence", () => {
	test.skipIf(!TOOL_AVAILABLE)(
		"adds one advisory namespaced entry beside the native duplication result, score untouched",
		async () => {
			await seedClonePair(repo);
			const native = await auditWorkspace(repo, { now: PINNED });
			const before = await stagedScratchCount();
			const enriched = await auditWorkspace(repo, {
				config: providerAuditConfig(jscpd("exact")),
				now: PINNED,
			});
			// The report validates; the owned scratch is cleaned up.
			expect(auditReportSchema.parse(enriched)).toEqual(enriched);
			expect(await stagedScratchCount()).toBe(before);
			// Native measurement, score and findings are identical (§16.5).
			expect(enriched.score).toEqual(native.score);
			expect(enriched.metrics).toEqual(native.metrics);
			expect(enriched.findings).toEqual(native.findings);
			expect(enriched.completeness).toBe("complete");
			expect(enriched.score.partial).toBe(false);
			// Exactly one jscpd entry joins the evidence area — advisory,
			// owning no native metric ids, never in the metrics map or findings.
			const entry = providerEntry(enriched, "jscpd");
			expect(entry.scoring).toBe("advisory");
			expect(entry.metricIds).toEqual([]);
			expect(entry.state).toBe("complete");
			expect(entry.provider).toMatchObject({
				kind: "external",
				id: "jscpd",
				toolVersion: "5.2.1",
				mode: "exact",
			});
			expect(evidenceArea(enriched).completeness).toBe("complete");
			for (const id of Object.keys(enriched.metrics)) {
				expect(id.startsWith("provider.")).toBe(false);
			}
			for (const finding of enriched.findings) {
				expect(finding.kind.startsWith("provider.")).toBe(false);
			}
			// Namespaced evidence lives inside the entry, beside the native
			// duplication analysis's own entry (§6.6): no collision, no scoring.
			expect(entry.metrics?.map((metric) => metric.id)).toEqual([
				"provider.jscpd.duplication.affected-code-lines.production",
				"provider.jscpd.duplication.affected-code-lines.test",
				"provider.jscpd.duplication.clone-groups",
				"provider.jscpd.duplication.clone-pairs",
			]);
			expect(carriedProviderIds(enriched)).toContain("trellis.duplication");
			const pairs = entry.cloneEvidence?.filter((clone) => clone.kind === "pair") ?? [];
			expect(pairs).toHaveLength(1);
			expect(entry.findings?.map((finding) => finding.kind)).toEqual(["provider.jscpd.clone-pair"]);
			// The analysis observed exactly its staged selection (asserted
			// coverage, never inferred from the exit status).
			expect(entry.observedCoverage?.analyzedFiles).toEqual(["src/clone-a.ts", "src/clone-b.ts"]);
		},
	);

	test.skipIf(!TOOL_AVAILABLE)("folds deterministically across runs", async () => {
		await seedClonePair(repo);
		const config = providerAuditConfig(jscpd("exact"));
		const first = await runProviderAnalyses(repo, await inventory(), config);
		const second = await runProviderAnalyses(repo, await inventory(), config);
		expect(second).toEqual(first);
		expect(first[0]?.provider.mode).toBe("exact");
	});
});

describe("provider failures stay located evidence with native results intact", () => {
	test("an unresolvable pinned tool is unavailable with install instructions", async () => {
		await seedClonePair(repo);
		const nowhere = await mkdtemp(join(tmpdir(), "trellis-no-tools-"));
		try {
			const results = await runProviderAnalyses(
				repo,
				await inventory(),
				providerAuditConfig(jscpd("exact")),
				{
					resolve: { fromDir: nowhere },
				},
			);
			expect(results[0]?.state).toBe("unavailable");
			expect(results[0]?.reason).toMatch(/not installed where trellis resolves from/);
			expect(results[0]?.reason).toMatch(/bun install|npm install/);
		} finally {
			await rm(nowhere, { recursive: true, force: true });
		}
	});

	test("an incompatible installed version is unavailable, naming the exact pin", async () => {
		await seedClonePair(repo);
		const wrongVersion = await mkdtemp(join(tmpdir(), "trellis-wrong-pin-"));
		try {
			const pkg = join(wrongVersion, "node_modules", "jscpd");
			await mkdir(pkg, { recursive: true });
			await writeFile(
				join(pkg, "package.json"),
				JSON.stringify({ name: "jscpd", version: "5.2.0", bin: { jscpd: "./run-jscpd.js" } }),
			);
			const results = await runProviderAnalyses(
				repo,
				await inventory(),
				providerAuditConfig(jscpd("exact")),
				{
					resolve: { fromDir: wrongVersion },
				},
			);
			expect(results[0]?.state).toBe("unavailable");
			expect(results[0]?.reason).toMatch(/is version "5\.2\.0", but the pin is exactly 5\.2\.1/);
		} finally {
			await rm(wrongVersion, { recursive: true, force: true });
		}
	});

	test.skipIf(!TOOL_AVAILABLE)(
		"an omitted below-threshold file makes the analysis incomplete without touching the score",
		async () => {
			await seedClonePair(repo);
			await putFile(repo, "src/tiny.ts", TINY_FN);
			const native = await auditWorkspace(repo, { now: PINNED });
			const enriched = await auditWorkspace(repo, {
				config: providerAuditConfig(jscpd("exact")),
				now: PINNED,
			});
			const entry = providerEntry(enriched, "jscpd");
			expect(entry.state).toBe("incomplete");
			expect(entry.reason).toMatch(/omitted from jscpd's source statistics/);
			// The native result stays complete: evidence completeness degrades,
			// the score does not (§16.2).
			expect(enriched.score).toEqual(native.score);
			expect(enriched.completeness).toBe("complete");
			expect(enriched.score.partial).toBe(false);
			expect(evidenceArea(enriched).completeness).toBe("incomplete");
			// What the analysis observed stays visible (no invented zeros):
			// the above-threshold pair is still evidence on the entry.
			expect(entry.observedCoverage?.analyzedFiles).toEqual([]);
			const pairs = entry.metrics?.find(
				(metric) => metric.id === "provider.jscpd.duplication.clone-pairs",
			);
			expect(pairs?.value).toBe(1);
			expect(auditReportSchema.parse(enriched)).toEqual(enriched);
		},
	);

	test("a staging failure is unavailable evidence, never an audit abort", async () => {
		await seedClonePair(repo);
		const source = await inventory();
		await rm(repo, { recursive: true, force: true });
		const results = await runProviderAnalyses(repo, source, providerAuditConfig(jscpd("exact")));
		expect(results[0]?.state).toBe("unavailable");
		expect(results[0]?.reason).toMatch(/staging failed|could not resolve audited root/);
	});

	test("an empty measured selection is unsupported for these inputs", async () => {
		await writeFile(join(repo, "README.md"), "no typescript here\n");
		const results = await runProviderAnalyses(
			repo,
			await inventory(),
			providerAuditConfig(jscpd("near")),
		);
		expect(results[0]?.state).toBe("unsupported");
		expect(results[0]?.reason).toMatch(/measured production\/test selection is empty/);
	});

	test("a requested undelivered or gated capability is located unsupported evidence", async () => {
		await seedClonePair(repo);
		const results = await runProviderAnalyses(
			repo,
			await inventory(),
			providerAuditConfig({
				sonarjs: {},
				knip: {},
			}),
		);
		expect(results.map((result) => result.provider.id)).toEqual(["knip", "sonarjs"]);
		for (const result of results) {
			expect(result.state).toBe("unsupported");
			expect(result.provider.kind).toBe("external");
		}
		expect(results[1]?.reason).toMatch(/LGPL-3\.0-only/);
		expect(results[1]?.reason).toMatch(/deferred by docs\/sonarjs-decision\.md/);
	});

	test("cancellation propagates: nothing is staged and the evidence says so", async () => {
		await seedClonePair(repo);
		const before = await stagedScratchCount();
		const controller = new AbortController();
		controller.abort();
		const results = await runProviderAnalyses(
			repo,
			await inventory(),
			providerAuditConfig(jscpd("exact")),
			{
				signal: controller.signal,
			},
		);
		expect(results[0]?.state).toBe("unavailable");
		expect(results[0]?.reason).toMatch(/cancelled/);
		expect(await stagedScratchCount()).toBe(before);
	});
});
