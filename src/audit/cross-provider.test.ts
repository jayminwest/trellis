import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareReports, loadReportArtifact } from "../compare/index.ts";
import { resolvePinnedTool } from "../providers/resolve.ts";
import {
	evidenceArea,
	PINNED,
	providerAuditConfig,
	providerEntry,
	putFile,
	seedClonePair,
	TINY_FN,
} from "./provider-fixtures.ts";
import { runWorkspaceAudit } from "./run.ts";

// trellis-1e03: authored controls, real pinned processes and saved artifacts.
// Update expectations only after reviewing the provider identity and raw
// evidence; run `bun test src/audit/cross-provider.test.ts` to validate.
const AVAILABLE = ["jscpd", "dependency-cruiser"].every(
	(id) => resolvePinnedTool(id).state === "available",
);
const selection = {
	jscpd: { mode: "exact" as const },
	"dependency-cruiser": {
		rules: [{ kind: "cycle" as const, name: "runtime-cycles", edges: ["runtime" as const] }],
	},
	sonarjs: {},
};
let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "trellis-cross-provider-"));
	await seedClonePair(root);
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("cross-provider evidence isolation", () => {
	test.skipIf(!AVAILABLE)(
		"repeats a shared corpus without changing native measurements",
		async () => {
			const native = await runWorkspaceAudit(root, { now: PINNED });
			const config = providerAuditConfig(selection);
			const first = await runWorkspaceAudit(root, { config, now: PINNED });
			const second = await runWorkspaceAudit(root, { config, now: PINNED });
			expect(evidenceArea(second.report)).toEqual(evidenceArea(first.report));
			expect(first.report.score).toEqual(native.report.score);
			expect(first.report.metrics).toEqual(native.report.metrics);
			expect(first.report.findings).toEqual(native.report.findings);
			const clones = providerEntry(first.report, "jscpd");
			const architecture = providerEntry(first.report, "dependency-cruiser");
			expect(clones.state).toBe("complete");
			expect(architecture.state).toBe("complete");
			expect(clones.analysis?.selection.files).toEqual(architecture.analysis?.selection.files);
			expect(clones.findings).toHaveLength(1);
			expect(architecture.findings).toEqual([]);
			expect(providerEntry(first.report, "sonarjs").state).toBe("unsupported");
			expect(first.policy.failed).toBe(false);
			expect(compareReports(native.report, first.report).score?.delta).toBe(0);

			const artifact = join(root, "report.json");
			await writeFile(artifact, JSON.stringify(first.report));
			const loaded = await loadReportArtifact(artifact);
			expect(loaded).toEqual(first.report);
			const changed = structuredClone(loaded);
			providerEntry(changed, "jscpd").provider.toolVersion = "future-test-version";
			const comparison = compareReports(loaded, changed);
			expect(comparison.score?.delta).toBe(0);
			expect(comparison.evidence.providers.find((p) => p.providerId === "jscpd")?.status).toBe(
				"noncomparable",
			);
			expect(
				comparison.evidence.providers.find((p) => p.providerId === "dependency-cruiser")?.status,
			).toBe("comparable");
		},
	);

	test.skipIf(!AVAILABLE)(
		"retains complete architecture evidence beside incomplete clones",
		async () => {
			await putFile(root, "src/tiny.ts", TINY_FN);
			const native = await runWorkspaceAudit(root, { now: PINNED });
			const config = providerAuditConfig(selection, {
				budgets: {},
				failOnNew: [],
				requireEvidence: ["jscpd", "dependency-cruiser", "sonarjs"],
			});
			const result = await runWorkspaceAudit(root, { config, now: PINNED });
			expect(providerEntry(result.report, "jscpd").state).toBe("incomplete");
			expect(providerEntry(result.report, "jscpd").findings).toHaveLength(1);
			expect(providerEntry(result.report, "dependency-cruiser").state).toBe("complete");
			expect(result.report.score).toEqual(native.report.score);
			expect(result.policy.failed).toBe(true);
			expect(
				result.policy.results
					.filter((r) => r.status === "fail")
					.map((r) => r.subject)
					.sort(),
			).toEqual(["jscpd", "sonarjs"]);
		},
	);
});
