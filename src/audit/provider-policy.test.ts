import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	carriedProviderIds,
	PINNED,
	providerAuditConfig,
	providerEntry,
	seedClonePair,
	TINY_FN,
	TOOL_AVAILABLE,
} from "./provider-fixtures.ts";
import { runWorkspaceAudit } from "./run.ts";

/**
 * Declarative requirements over provider evidence through the audit service
 * (SPEC §16.3, §6.5 `policy.requireEvidence`; step 7's family, exercised
 * end-to-end with step 15's provider-carrying reports — plan `pl-43c5`,
 * trellis-15e3): an unmet requirement trips policy (the CLI's exit `2`)
 * while the full native report is still produced, and a deferred capability
 * cites its recorded decision. Shared fixtures in `provider-fixtures.ts`.
 */

let repo: string;

beforeEach(async () => {
	repo = await mkdtemp(join(tmpdir(), "trellis-provider-policy-"));
	await seedClonePair(repo);
});

afterEach(async () => {
	await rm(repo, { recursive: true, force: true });
});

/** One audit-run configuration: provider selection plus evidence requirements. */
function requirementConfig(
	providers: Parameters<typeof providerAuditConfig>[0],
	requireEvidence: readonly string[],
) {
	return providerAuditConfig(providers, {
		budgets: {},
		failOnNew: [],
		requireEvidence: [...requireEvidence],
	});
}

describe("declarative requirements trip policy over provider evidence (step 7)", () => {
	test.skipIf(!TOOL_AVAILABLE)(
		"a required jscpd analysis that runs incomplete fails the policy closed, report still emitted",
		async () => {
			await writeFile(join(repo, "src", "tiny.ts"), TINY_FN);
			const { report, policy } = await runWorkspaceAudit(repo, {
				config: requirementConfig({ jscpd: { mode: "exact" } }, ["jscpd"]),
				now: PINNED,
			});
			expect(policy.failed).toBe(true);
			const requirement = policy.results.find((result) => result.subject === "jscpd");
			expect(requirement?.status).toBe("fail");
			expect(requirement?.reasons[0]?.code).toBe("requirement-evidence-incomplete");
			// The report is still emitted with the full native result.
			expect(providerEntry(report, "jscpd").state).toBe("incomplete");
			expect(report.score.partial).toBe(false);
		},
	);

	test("a required analysis the run did not request fails closed as unrequested", async () => {
		const { report, policy } = await runWorkspaceAudit(repo, {
			config: requirementConfig({}, ["jscpd"]),
			now: PINNED,
		});
		expect(policy.failed).toBe(true);
		const requirement = policy.results.find((result) => result.subject === "jscpd");
		expect(requirement?.reasons[0]?.code).toBe("requirement-analysis-unrequested");
		expect(carriedProviderIds(report)).not.toContain("jscpd");
	});

	test("requiring the deferred sonarjs capability cites the recorded decision", async () => {
		const { report, policy } = await runWorkspaceAudit(repo, {
			config: requirementConfig({ sonarjs: {} }, ["sonarjs"]),
			now: PINNED,
		});
		expect(policy.failed).toBe(true);
		const requirement = policy.results.find((result) => result.subject === "sonarjs");
		expect(requirement?.reasons[0]?.code).toBe("requirement-evidence-unsupported");
		expect(requirement?.reasons[0]?.message).toMatch(/docs\/sonarjs-decision\.md/);
		// The located unsupported entry carries the same recorded reason.
		const entry = providerEntry(report, "sonarjs");
		expect(entry.state).toBe("unsupported");
		expect(report.score.partial).toBe(false);
	});
});
