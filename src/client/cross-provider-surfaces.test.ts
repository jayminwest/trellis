import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkspaceAudit } from "../audit/index.ts";
import { providerEntry, seedClonePair, TOOL_AVAILABLE } from "../audit/provider-fixtures.ts";
import { auditReportSchema } from "../contract/index.ts";
import { resolvePinnedTool } from "../providers/resolve.ts";
import * as client from "./index.ts";

// trellis-1e03: combined complete/deferred evidence across the actual surfaces.
let root: string;
let configPath: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "trellis-cross-surfaces-"));
	await seedClonePair(root);
	configPath = join(root, "trellis.yaml");
	await writeFile(
		configPath,
		"providers:\n  jscpd: { mode: exact }\n  sonarjs: {}\n  knip: { entries: [src/clone-a.ts] }\n" +
			"  dependency-cruiser:\n    rules: [{kind: cycle, name: runtime-cycles, edges: [runtime]}]\n",
	);
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});
function withoutRun<T extends { run?: unknown }>(report: T) {
	const { run: _run, ...stable } = report;
	return stable;
}

describe("cross-provider public surfaces", () => {
	test.skipIf(
		!TOOL_AVAILABLE ||
			["knip", "dependency-cruiser"].some((id) => resolvePinnedTool(id).state !== "available"),
	)(
		"preserves mixed evidence through CLI, SDK, fleet and SQLite",
		async () => {
			const core = await runWorkspaceAudit(root);
			const sdk = await client.audit(root);
			expect(withoutRun(sdk.report)).toEqual(withoutRun(core.report));
			// State with its reason, so an incomplete run names its cause (trellis-3dfe).
			for (const id of ["jscpd", "knip", "dependency-cruiser"]) {
				const { state, reason } = providerEntry(core.report, id);
				expect({ id, state, reason }).toEqual({ id, state: "complete", reason: undefined });
			}
			expect(providerEntry(core.report, "sonarjs").state).toBe("unsupported");
			const cli = Bun.spawn(
				[process.execPath, join(import.meta.dir, "../cli/main.ts"), "audit", root, "--json"],
				{
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [stdout, stderr, code] = await Promise.all([
				new Response(cli.stdout).text(),
				new Response(cli.stderr).text(),
				cli.exited,
			]);
			expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
			expect(withoutRun(auditReportSchema.parse(JSON.parse(stdout)))).toEqual(
				withoutRun(core.report),
			);
			const targets = join(root, "targets.yaml");
			await writeFile(targets, `targets:\n  - id: shared\n    path: ${JSON.stringify(root)}\n`);
			const fleet = await client.fleet(targets);
			const member = fleet.entries[0];
			if (!member?.ok) throw new Error("expected a successful fleet member");
			expect(withoutRun(member.report)).toEqual(withoutRun(core.report));
			const db = join(root, "history.db");
			const stored = await client.audit(root, { history: true, db });
			expect(stored.historyRunId).toBeGreaterThan(0);
			await writeFile(configPath, "providers:\n  sonarjs: {}\n");
			const next = await client.audit(root, { history: true, db });
			expect(next.baseline).toEqual(stored.report);
			expect(next.report.score).toEqual(stored.report.score);
			expect(providerEntry(next.baseline as client.AuditReport, "jscpd").state).toBe("complete");
		},
		20_000,
	);
});
