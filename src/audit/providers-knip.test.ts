import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSourceInventory } from "../discovery/index.ts";
import { runKnipAnalysis } from "../providers/knip/analysis.ts";
import { compileReachabilityPolicy } from "../providers/knip/policy.ts";
import { resolvePinnedTool } from "../providers/resolve.ts";
import { KNIP_TOOL_AVAILABLE, providerAuditConfig, seedClonePair } from "./provider-fixtures.ts";
import { runProviderAnalyses } from "./providers.ts";

/**
 * The knip provider through the core's execution plan (SPEC §16.3–§16.5,
 * plan `pl-43c5` step 24 — trellis-8ebc): a requested knip runs the
 * delivered adapter through the same core path and folds into located
 * contract evidence — contextual advisory candidates and recorded
 * assumptions over the declared reachability model, never a score
 * contribution (the adapter's own suites live in
 * `src/providers/knip/`).
 */

/** Real-binary tests run only where the pinned knip resolved on this host. */
const TOOL_AVAILABLE = KNIP_TOOL_AVAILABLE;

let repo: string;

beforeEach(async () => {
	repo = await mkdtemp(join(tmpdir(), "trellis-providers-knip-"));
});

afterEach(async () => {
	await rm(repo, { recursive: true, force: true });
});

/** The discovered inventory of the temp repo (an actual file inventory). */
async function inventory() {
	return discoverSourceInventory(repo);
}

describe("an explicitly requested knip adds unscored reachability evidence", () => {
	test.skipIf(!TOOL_AVAILABLE)(
		"a requested knip emits contextual advisory reachability evidence through the same core",
		async () => {
			await seedClonePair(repo);
			const results = await runProviderAnalyses(
				repo,
				await inventory(),
				providerAuditConfig({ knip: {} }),
			);
			expect(results).toHaveLength(1);
			const result = results[0];
			if (result === undefined) throw new Error("expected knip evidence");
			expect(result.provider.id).toBe("knip");
			expect(result.provider.mode).toBe("contextual");
			expect(result.state).toBe("complete");
			// No entry is declared, so the reachability model is honest about it:
			// recorded assumptions, contextual candidates, never dead code.
			expect(result.observedCoverage?.analyzedFiles).toEqual(["src/clone-a.ts", "src/clone-b.ts"]);
			expect(result.findings?.map((finding) => finding.kind)).toEqual([
				"provider.knip.unused-file",
				"provider.knip.unused-file",
			]);
			const assumptions = result.metrics?.find(
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
		},
		20_000,
	);

	test("an unresolvable pinned knip is unavailable with install instructions", async () => {
		await seedClonePair(repo);
		const results = await runProviderAnalyses(
			repo,
			await inventory(),
			providerAuditConfig({ knip: {} }),
			{ resolve: { fromDir: join(tmpdir(), "trellis-knip-not-installed-") } },
		);
		expect(results[0]?.state).toBe("unavailable");
		expect(results[0]?.reason).toContain("is not installed where trellis resolves from");
		expect(results[0]?.reason).toContain("never at audit time");
	});

	test("compiles the declared reachability request before anything runs", () => {
		const policy = compileReachabilityPolicy({
			entries: ["src/cli/main.ts"],
			public: [{ path: "src/index.ts" }],
			tests: "roots",
		});
		expect(policy.identityOptions["reachability-entry-count"]).toBe(1);
		expect(policy.identityOptions["reachability-test-mode"]).toBe("roots");
		expect(policy.digest).toMatch(/^[0-9a-f]{64}$/);
	});

	test("a production-less measured selection is unsupported — no candidates to scope", async () => {
		await seedClonePair(repo);
		const result = await runKnipAnalysis(
			repo,
			[{ path: "src/main.test.ts", sourceSet: "test", packagePath: "." }],
			{},
		);
		expect(result.state).toBe("unsupported");
		expect(result.reason).toContain("no production files");
		expect(resolvePinnedTool("knip").state === "available").toBe(TOOL_AVAILABLE);
	});
});
