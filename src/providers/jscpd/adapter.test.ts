import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolvePinnedTool } from "../resolve.ts";
import { withStagedWorkspaceView } from "../staged-run.ts";
import { type StagedWorkspaceView, stageWorkspaceView } from "../workspace.ts";
import { runJscpdAdapter } from "./adapter.ts";
import { InvalidJscpdRequestError, JSCPD_DEFAULT_THRESHOLDS } from "./invocation.ts";

/** Real-binary tests run only where the pinned artifact resolved on this host. */
const TOOL_AVAILABLE = resolvePinnedTool("jscpd").state === "available";

/** The spike's 88-token fixture function (above the 50-token threshold). */
const TOTAL_FUNCTION = `export function total(items: number[], limit: number): number {
 let subtotal = 0;
 let accepted = 0;
 for (const item of items) {
  if (item > limit) {
   subtotal += item * 2;
   accepted += 1;
  } else {
   subtotal += item;
  }
 }
 const result = subtotal / Math.max(accepted, 1);
 return Math.round(result * 100) / 100;
}
`;

/** Stage a real temp workspace and hand the caller both view and root. */
async function withWorkspace(
	files: Record<string, string>,
	run: (view: StagedWorkspaceView, root: string) => Promise<void>,
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "trellis-jscpd-adapter-"));
	try {
		for (const [path, source] of Object.entries(files)) {
			await mkdir(dirname(join(root, path)), { recursive: true });
			await writeFile(join(root, path), source);
		}
		const view = await stageWorkspaceView({
			root,
			files: Object.keys(files).map((path) => ({
				path,
				sourceSet: "production" as const,
				packagePath: ".",
			})),
		});
		try {
			await run(view, root);
		} finally {
			await view.cleanup();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("runJscpdAdapter requests", () => {
	test("rejects invalid requests as operational errors before anything runs", async () => {
		await withWorkspace({ "a.ts": TOTAL_FUNCTION }, async (view) => {
			await expect(runJscpdAdapter(view, { modes: [] })).rejects.toThrow(InvalidJscpdRequestError);
			await expect(runJscpdAdapter(view, { modes: ["typed"] as never })).rejects.toThrow(
				"unknown jscpd match mode",
			);
			await expect(
				runJscpdAdapter(view, { thresholds: { ...JSCPD_DEFAULT_THRESHOLDS, similarity: 0 } }),
			).rejects.toThrow("invalid thresholds");
			await expect(runJscpdAdapter(view, { timeoutMs: 0 })).rejects.toThrow(
				"timeoutMs must be a positive integer",
			);
		});
	});

	test("rejects an empty staged selection", async () => {
		await withWorkspace({}, async (view) => {
			await expect(runJscpdAdapter(view)).rejects.toThrow(InvalidJscpdRequestError);
		});
	});

	test("locates a missing pinned binary as unavailable evidence with instructions", async () => {
		const empty = await mkdtemp(join(tmpdir(), "trellis-jscpd-unresolved-"));
		try {
			await withWorkspace({ "a.ts": TOTAL_FUNCTION }, async (view) => {
				const result = await runJscpdAdapter(view, {
					modes: ["exact", "near"],
					resolve: { fromDir: empty },
				});
				expect(result.resolution.state).toBe("unavailable");
				expect(result.resolution.state === "unavailable" && result.resolution.reason).toContain(
					"not installed",
				);
				expect(result.outcomes).toHaveLength(2);
				for (const outcome of result.outcomes) {
					expect(outcome).toMatchObject({
						state: "unavailable",
						reason: expect.stringContaining("not installed"),
						instructions: expect.stringContaining("bun install"),
					});
					expect(Object.hasOwn(outcome, "analysis")).toBe(false);
					expect(Object.hasOwn(outcome, "report")).toBe(false);
				}
			});
		} finally {
			await rm(empty, { recursive: true, force: true });
		}
	});
});

describe("runJscpdAdapter (real pinned binary)", () => {
	test.skipIf(!TOOL_AVAILABLE)(
		"runs every requested mode with complete validated evidence",
		async () => {
			await withWorkspace(
				{ "a.ts": TOTAL_FUNCTION, "b.ts": TOTAL_FUNCTION },
				async (view, root) => {
					const result = await runJscpdAdapter(view, { modes: ["near", "exact"] });
					expect(result.toolVersion).toBe("5.2.1");
					expect(result.adapterVersion).toBe("0.1.0");
					expect(result.resolution.state).toBe("available");
					expect(result.outcomes.map((outcome) => outcome.mode)).toEqual(["exact", "near"]);
					for (const outcome of result.outcomes) {
						expect(outcome.state).toBe("complete");
					}
					// The provider never writes into the target workspace (owned scratch only).
					expect((await readdir(root)).sort()).toEqual(["a.ts", "b.ts"]);
				},
			);
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"runs through the staged-view lifecycle with owned cleanup",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "trellis-jscpd-lifecycle-"));
			try {
				await writeFile(join(root, "a.ts"), TOTAL_FUNCTION);
				await writeFile(join(root, "b.ts"), TOTAL_FUNCTION);
				const run = await withStagedWorkspaceView(
					{
						root,
						files: [
							{ path: "a.ts", sourceSet: "production", packagePath: "." },
							{ path: "b.ts", sourceSet: "production", packagePath: "." },
						],
					},
					(view) => runJscpdAdapter(view, { modes: ["exact"] }),
					{ timeoutMs: 60_000 },
				);
				expect(run.kind).toBe("completed");
				expect(run.kind === "completed" && run.value.outcomes[0]?.state).toBe("complete");
				expect(run.cleanup.status).toBe("cleaned");
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"records exhausted output limits as unavailable, never clean",
		async () => {
			await withWorkspace({ "a.ts": TOTAL_FUNCTION }, async (view) => {
				const result = await runJscpdAdapter(view, { modes: ["exact"], maxOutputBytes: 8 });
				const outcome = result.outcomes[0];
				expect(outcome?.state).toBe("unavailable");
				expect(outcome && outcome.state !== "complete" ? outcome.reason : "").toContain(
					"version check could not run",
				);
			});
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"records exhausted wall-time limits as unavailable, never clean",
		async () => {
			await withWorkspace({ "a.ts": TOTAL_FUNCTION }, async (view) => {
				const result = await runJscpdAdapter(view, { modes: ["exact"], timeoutMs: 1 });
				const outcome = result.outcomes[0];
				expect(outcome?.state).toBe("unavailable");
				expect(outcome && outcome.state !== "complete" ? outcome.reason : "").toMatch(
					/version check could not run|wall-time limit/,
				);
			});
		},
	);
});
