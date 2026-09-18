/**
 * Staged-lifecycle failure regressions for the knip provider (plan
 * `pl-43c5` step 24 — trellis-8ebc, acceptance 4): the adapter- and
 * analysis-level failures — an empty staged scope, a version check that
 * cannot run, a pinned tool with no locally resolvable parser, an
 * unreadable runtime plugin registry, an unsupported host, a staging
 * failure, an invalid request and the lifecycle's own wall-time limit —
 * each yield their explicit located status through the real staged
 * boundaries, never a clean pass.
 */
import { describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	analysisResultSchema,
	type KnipProviderRequest,
	type SourceSet,
} from "../../contract/index.ts";
import { resolvePinnedTool } from "../resolve.ts";
import { stageWorkspaceView } from "../workspace.ts";
import { runKnipAdapter } from "./adapter.ts";
import { runKnipAnalysis } from "./analysis.ts";
import {
	fixtureSelection,
	REACHABILITY_FIXTURE,
	REACHABILITY_REQUEST,
	withReachabilityWorkspace,
} from "./conformance.ts";
import { prepareReachabilityContext } from "./context.ts";
import { compileReachabilityPolicy } from "./policy.ts";

/** Real-binary tests run only where the pinned artifact resolved on this host. */
const TOOL_AVAILABLE = resolvePinnedTool("knip").state === "available";

/** The unavailable variant of an adapter outcome's underlying result. */
function unavailableReason(adapter: Awaited<ReturnType<typeof runKnipAdapter>>): string {
	const outcome = adapter.outcome;
	if (outcome.state === "unavailable" || outcome.state === "unsupported") return outcome.reason;
	throw new Error(`expected a never-ran outcome, got "${outcome.state}"`);
}

/** The prepared fixture context over the given staged selection. */
function contextOver(files: readonly { path: string; sourceSet: SourceSet }[]) {
	return prepareReachabilityContext(compileReachabilityPolicy(REACHABILITY_REQUEST), files);
}

/** The measured fixture selection. */
const FIXTURE_SELECTION = fixtureSelection(Object.keys(REACHABILITY_FIXTURE));

describe("runKnipAdapter and analysis failure regressions (staged lifecycle)", () => {
	test.skipIf(!TOOL_AVAILABLE)(
		"an empty staged scope cannot assert reachability coverage — unavailable, never clean",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "trellis-knip-empty-view-"));
			try {
				const view = await stageWorkspaceView({ root, files: [] });
				try {
					const adapter = await runKnipAdapter(view, contextOver([]));
					expect(unavailableReason(adapter)).toContain("the staged scope is empty");
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
			await withReachabilityWorkspace(REACHABILITY_FIXTURE, async (view) => {
				const adapter = await runKnipAdapter(view, contextOver(view.files), { maxOutputBytes: 4 });
				expect(unavailableReason(adapter)).toContain("version check could not run");
			});
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"a pinned tool with no local parser is unavailable — never an assumed parser",
		async () => {
			const resolution = resolvePinnedTool("knip");
			if (resolution.state !== "available") return;
			const isolated = await mkdtemp(join(tmpdir(), "trellis-knip-no-parser-"));
			try {
				const packageRoot = dirname(dirname(resolution.executablePath));
				await mkdir(join(isolated, "node_modules"), { recursive: true });
				await cp(packageRoot, join(isolated, "node_modules", "knip"), { recursive: true });
				await withReachabilityWorkspace(REACHABILITY_FIXTURE, async (view) => {
					const adapter = await runKnipAdapter(view, contextOver(view.files), {
						resolve: { fromDir: isolated },
					});
					expect(adapter.resolution.state).toBe("available");
					const parser = adapter.parser;
					if (!("version" in parser)) {
						expect(parser.reason).toContain("resolves no local oxc-parser");
						expect(unavailableReason(adapter)).toContain("resolves no local oxc-parser");
					} else {
						throw new Error("expected the isolated tree to resolve no parser");
					}
				});
			} finally {
				await rm(isolated, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"an unreadable runtime plugin registry is a located refusal — never a guessed subset",
		async () => {
			const resolution = resolvePinnedTool("knip");
			if (resolution.state !== "available") return;
			const isolated = await mkdtemp(join(tmpdir(), "trellis-knip-no-registry-"));
			try {
				const packageRoot = dirname(dirname(resolution.executablePath));
				await mkdir(join(isolated, "node_modules"), { recursive: true });
				await cp(packageRoot, join(isolated, "node_modules", "knip"), { recursive: true });
				// The parser resolves from the copied dependency tree; the
				// registry file is removed so plugin discovery cannot be disabled.
				const parserRoot = join(dirname(packageRoot), "oxc-parser");
				await cp(parserRoot, join(isolated, "node_modules", "oxc-parser"), { recursive: true });
				await rm(join(isolated, "node_modules/knip/dist/plugins/index.js"), { force: true });
				await withReachabilityWorkspace(REACHABILITY_FIXTURE, async (view) => {
					const adapter = await runKnipAdapter(view, contextOver(view.files), {
						resolve: { fromDir: isolated },
					});
					expect(adapter.resolution.state).toBe("available");
					expect("version" in adapter.parser).toBe(true);
					const plugins = adapter.disabledPlugins;
					if (typeof plugins !== "number") {
						expect(plugins.state).toBe("unavailable");
						expect(plugins.reason).toContain("plugin registry cannot be enumerated");
						expect(unavailableReason(adapter)).toContain("plugin registry cannot be enumerated");
					} else {
						throw new Error("expected a registry refusal");
					}
				});
			} finally {
				await rm(isolated, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(!TOOL_AVAILABLE)("an unsupported host is located unsupported evidence", async () => {
		await withReachabilityWorkspace(REACHABILITY_FIXTURE, async (view) => {
			const adapter = await runKnipAdapter(view, contextOver(view.files), {
				resolve: { host: { platform: "win32", arch: "x64", libc: undefined } },
			});
			expect(adapter.resolution.state).toBe("unsupported");
			expect(unavailableReason(adapter)).toContain("no pinned knip platform binary is declared");
		});
	});

	test("a staging failure is unavailable evidence, never an audit abort", async () => {
		const root = await mkdtemp(join(tmpdir(), "trellis-knip-staging-"));
		try {
			await rm(root, { recursive: true, force: true });
			const result = await runKnipAnalysis(root, FIXTURE_SELECTION, REACHABILITY_REQUEST);
			expect(result.state).toBe("unavailable");
			expect(result.reason).toMatch(/staging failed|could not resolve audited root/);
			expect(analysisResultSchema.parse(result)).toEqual(result);
		} finally {
			await rm(root, { recursive: true, force: true }).catch(() => {});
		}
	});

	test("an invalid request is an operational error rejected before anything runs (§16.3)", async () => {
		const root = await mkdtemp(join(tmpdir(), "trellis-knip-invalid-"));
		try {
			const invalid = { entries: ["../escape.ts"] } as unknown as KnipProviderRequest;
			await expect(runKnipAnalysis(root, FIXTURE_SELECTION, invalid)).rejects.toThrow(
				/must be a repo-relative POSIX path/,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test.skipIf(!TOOL_AVAILABLE)(
		"the lifecycle's own wall-time limit is unavailable evidence with owned cleanup",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "trellis-knip-timeout-"));
			try {
				for (const [path, source] of Object.entries(REACHABILITY_FIXTURE)) {
					await mkdir(dirname(join(root, path)), { recursive: true });
					await writeFile(join(root, path), source);
				}
				const result = await runKnipAnalysis(root, FIXTURE_SELECTION, REACHABILITY_REQUEST, {
					timeoutMs: 1,
				});
				expect(result.state).toBe("unavailable");
				expect(result.reason).toContain("exceeded its wall-time limit");
				expect(analysisResultSchema.parse(result)).toEqual(result);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);
});
