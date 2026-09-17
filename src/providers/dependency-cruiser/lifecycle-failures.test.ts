/**
 * Staged-lifecycle failure regressions for the dependency-cruiser provider
 * (plan `pl-43c5` step 22 — trellis-adbf, acceptance 4): the adapter- and
 * analysis-level failures — an empty staged selection, a version check that
 * cannot run, a pinned tool with no locally resolvable TypeScript parser, a
 * staging failure, an invalid request and the lifecycle's own wall-time
 * limit — each yield their explicit located status through the real staged
 * boundaries, never a clean pass.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	analysisResultSchema,
	type DependencyCruiserProviderRequest,
} from "../../contract/index.ts";
import { resolvePinnedTool } from "../resolve.ts";
import { stageWorkspaceView } from "../workspace.ts";
import { runDependencyCruiserAdapter } from "./adapter.ts";
import { runDependencyCruiserAnalysis } from "./analysis.ts";
import {
	ARCHITECTURE_FIXTURE,
	ARCHITECTURE_REQUEST,
	productionSelection,
	withArchitectureWorkspace,
} from "./conformance.ts";
import type { DependencyCruiserOutcome } from "./cruise-run.ts";

/** Real-binary tests run only where the pinned artifact resolved on this host. */
const TOOL_AVAILABLE = resolvePinnedTool("dependency-cruiser").state === "available";

/** The unavailable variant of an outcome, fails fast otherwise. */
function unavailableOf(
	outcome: DependencyCruiserOutcome,
): Extract<DependencyCruiserOutcome, { state: "unavailable" | "unsupported" }> {
	if (outcome.state !== "complete" && outcome.state !== "incomplete") return outcome;
	throw new Error(`expected a never-ran outcome, got "${outcome.state}"`);
}

describe("runDependencyCruiserAdapter and analysis failure regressions (staged lifecycle)", () => {
	test.skipIf(!TOOL_AVAILABLE)(
		"an empty staged selection cannot assert architecture coverage — unavailable, never clean",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "trellis-dc-empty-view-"));
			try {
				const view = await stageWorkspaceView({ root, files: [] });
				try {
					const adapter = await runDependencyCruiserAdapter(view, ARCHITECTURE_REQUEST);
					expect(unavailableOf(adapter.outcome).reason).toContain("the staged selection is empty");
				} finally {
					await view.cleanup();
				}
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"a version check that cannot run is unavailable, never a clean result",
		async () => {
			await withArchitectureWorkspace(ARCHITECTURE_FIXTURE, async (view) => {
				const adapter = await runDependencyCruiserAdapter(view, ARCHITECTURE_REQUEST, {
					maxOutputBytes: 4,
				});
				expect(unavailableOf(adapter.outcome).reason).toContain("version check could not run");
			});
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"a pinned tool with no local TypeScript parser is unavailable — never an assumed parser",
		async () => {
			// A digest-verified copy of the real pinned package in an isolated
			// tree with no typescript anywhere in its resolution chain.
			const resolution = resolvePinnedTool("dependency-cruiser");
			if (resolution.state !== "available") return;
			const isolated = await mkdtemp(join(tmpdir(), "trellis-dc-no-parser-"));
			try {
				const packageRoot = dirname(dirname(resolution.executablePath));
				await mkdir(join(isolated, "node_modules"), { recursive: true });
				await cp(packageRoot, join(isolated, "node_modules", "dependency-cruiser"), {
					recursive: true,
				});
				await withArchitectureWorkspace(ARCHITECTURE_FIXTURE, async (view) => {
					const adapter = await runDependencyCruiserAdapter(view, ARCHITECTURE_REQUEST, {
						resolve: { fromDir: isolated },
					});
					expect(adapter.resolution.state).toBe("available");
					const parser = adapter.parser;
					if (!("version" in parser)) {
						expect(parser.reason).toContain("resolves no local TypeScript compiler");
						expect(unavailableOf(adapter.outcome).reason).toContain(
							"exits successfully with an empty graph",
						);
					} else {
						throw new Error("expected the isolated tree to resolve no TypeScript parser");
					}
				});
			} finally {
				await rm(isolated, { recursive: true, force: true });
			}
		},
	);

	test("a staging failure is unavailable evidence, never an audit abort", async () => {
		const root = await mkdtemp(join(tmpdir(), "trellis-dc-staging-"));
		try {
			const source = productionSelection(Object.keys(ARCHITECTURE_FIXTURE));
			await rm(root, { recursive: true, force: true });
			const result = await runDependencyCruiserAnalysis(root, source, ARCHITECTURE_REQUEST);
			expect(result.state).toBe("unavailable");
			expect(result.reason).toMatch(/staging failed|could not resolve audited root/);
			expect(analysisResultSchema.parse(result)).toEqual(result);
		} finally {
			await rm(root, { recursive: true, force: true }).catch(() => {});
		}
	});

	test("an invalid request is an operational error rejected before anything runs (§16.3)", async () => {
		const root = await mkdtemp(join(tmpdir(), "trellis-dc-invalid-"));
		try {
			const invalid = {
				rules: [{ kind: "boundary", allowance: "forbidden" }],
			} as unknown as DependencyCruiserProviderRequest;
			await expect(
				runDependencyCruiserAnalysis(
					root,
					productionSelection(Object.keys(ARCHITECTURE_FIXTURE)),
					invalid,
				),
			).rejects.toThrow(/invalid_dependency|expected object/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test.skipIf(!TOOL_AVAILABLE)(
		"the lifecycle's own wall-time limit is unavailable evidence with owned cleanup",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "trellis-dc-timeout-"));
			try {
				for (const [path, source] of Object.entries(ARCHITECTURE_FIXTURE)) {
					await mkdir(dirname(join(root, path)), { recursive: true });
					await writeFile(join(root, path), source);
				}
				const result = await runDependencyCruiserAnalysis(
					root,
					productionSelection(Object.keys(ARCHITECTURE_FIXTURE)),
					ARCHITECTURE_REQUEST,
					{ timeoutMs: 1 },
				);
				expect(result.state).toBe("unavailable");
				expect(result.reason).toContain("exceeded its wall-time limit");
				expect(existsSync(root)).toBe(true);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);
});
