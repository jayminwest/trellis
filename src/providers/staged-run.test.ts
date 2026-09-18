import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StagedRunOutcome } from "./staged-run.ts";
import { withStagedWorkspaceView } from "./staged-run.ts";
import type { StagedSelectionFile } from "./staging.ts";
import { InvalidStagingRequestError } from "./staging.ts";
import type { StagedWorkspaceView } from "./workspace.ts";

const IS_POSIX = process.platform !== "win32";
const IS_ROOT = process.getuid?.() === 0;

/** A minimal staged-selection request against a fresh one-file workspace. */
async function makeRequest(): Promise<{ root: string; files: StagedSelectionFile[] }> {
	const root = await mkdtemp(join(tmpdir(), "trellis-run-target-"));
	await writeFile(join(root, "a.ts"), "A\n");
	return { root, files: [{ path: "a.ts", sourceSet: "production", packagePath: "." }] };
}

/** Make `dir` undeletable for a non-root POSIX caller (an occupied read-only dir). */
async function makeUndeletable(dir: string): Promise<void> {
	await writeFile(join(dir, "occupant"), "blocker\n");
	await chmod(dir, 0o500);
}

async function releaseDir(dir: string): Promise<void> {
	await chmod(dir, 0o700).catch(() => {});
}

describe("withStagedWorkspaceView", () => {
	test("cleans up and returns the adapter value on success", async () => {
		const { root, files } = await makeRequest();
		try {
			const outcome = await withStagedWorkspaceView({ root, files }, async (view) => {
				expect(existsSync(join(view.stagedRoot, "a.ts"))).toBe(true);
				return view.files[0]?.sha256;
			});
			expect(outcome.kind).toBe("completed");
			if (outcome.kind === "completed") {
				expect(outcome.value).toHaveLength(64);
				expect(outcome.cleanup).toEqual({ status: "cleaned" });
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("carries adapter failures with cleanup instead of rethrowing", async () => {
		const { root, files } = await makeRequest();
		try {
			const boom = new Error("adapter exploded");
			const outcome = await withStagedWorkspaceView({ root, files }, async () => {
				throw boom;
			});
			expect(outcome).toEqual({
				kind: "adapter-failed",
				error: boom,
				cleanup: { status: "cleaned" },
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("stops waiting on the wall-time limit and cleans up immediately", async () => {
		const { root, files } = await makeRequest();
		try {
			let scratchDir = "";
			const outcome = await withStagedWorkspaceView(
				{ root, files },
				async (view) => {
					scratchDir = view.scratchDir;
					await Bun.sleep(5000);
					return "late";
				},
				{ timeoutMs: 150 },
			);
			expect(outcome).toEqual({ kind: "timeout", cleanup: { status: "cleaned" } });
			expect(existsSync(scratchDir)).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("aborts the handed-off handle on the wall-time limit", async () => {
		const { root, files } = await makeRequest();
		try {
			let observed: AbortSignal | undefined;
			const outcome = await withStagedWorkspaceView(
				{ root, files },
				async (_view, signal) => {
					observed = signal;
					// Only the lifecycle's limit can settle this callback.
					await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
					return "late";
				},
				{ timeoutMs: 150 },
			);
			expect(outcome).toEqual({ kind: "timeout", cleanup: { status: "cleaned" } });
			expect(observed?.aborted).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("aborts the handed-off handle on caller cancellation", async () => {
		const { root, files } = await makeRequest();
		try {
			const controller = new AbortController();
			let observed: AbortSignal | undefined;
			const pending = withStagedWorkspaceView(
				{ root, files },
				async (_view, signal) => {
					observed = signal;
					await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
					return "late";
				},
				{ signal: controller.signal },
			);
			setTimeout(() => controller.abort(), 100);
			const outcome = await pending;
			expect(outcome).toEqual({ kind: "cancelled", cleanup: { status: "cleaned" } });
			expect(observed?.aborted).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("completes when the adapter finishes within the limit", async () => {
		const { root, files } = await makeRequest();
		try {
			const outcome = await withStagedWorkspaceView(
				{ root, files },
				async () => {
					await Bun.sleep(20);
					return "done";
				},
				{ timeoutMs: 5000 },
			);
			expect(outcome.kind).toBe("completed");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("stops waiting on caller cancellation and cleans up", async () => {
		const { root, files } = await makeRequest();
		try {
			const controller = new AbortController();
			let scratchDir = "";
			const pending = withStagedWorkspaceView(
				{ root, files },
				async (view) => {
					scratchDir = view.scratchDir;
					await Bun.sleep(5000);
					return "late";
				},
				{ signal: controller.signal },
			);
			setTimeout(() => controller.abort(), 100);
			const outcome = await pending;
			expect(outcome).toEqual({ kind: "cancelled", cleanup: { status: "cleaned" } });
			expect(existsSync(scratchDir)).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("treats a signal aborted during staging as cancelled", async () => {
		const { root, files } = await makeRequest();
		try {
			const controller = new AbortController();
			const pending = withStagedWorkspaceView(
				{ root, files },
				async () => {
					await Bun.sleep(5000);
					return "late";
				},
				{ signal: controller.signal },
			);
			controller.abort();
			const outcome = await pending;
			expect(outcome).toEqual({ kind: "cancelled", cleanup: { status: "cleaned" } });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("stages nothing when the signal is already aborted", async () => {
		const { root, files } = await makeRequest();
		try {
			const controller = new AbortController();
			controller.abort();
			const outcome = await withStagedWorkspaceView({ root, files }, async () => "never", {
				signal: controller.signal,
			});
			expect(outcome).toEqual({ kind: "cancelled", cleanup: { status: "nothing-to-clean" } });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("rejects malformed run options and requests before staging", async () => {
		const { root, files } = await makeRequest();
		try {
			const request = { root, files };
			await expect(
				withStagedWorkspaceView(request, undefined as unknown as () => Promise<number>),
			).rejects.toThrow(InvalidStagingRequestError);
			await expect(withStagedWorkspaceView(request, async () => 1, null as never)).rejects.toThrow(
				InvalidStagingRequestError,
			);
			await expect(
				withStagedWorkspaceView(request, async () => 1, { timeoutMs: 0 }),
			).rejects.toThrow(InvalidStagingRequestError);
			await expect(
				withStagedWorkspaceView(request, async () => 1, { timeoutMs: 2.5 }),
			).rejects.toThrow(InvalidStagingRequestError);
			await expect(
				withStagedWorkspaceView(request, async () => 1, { signal: {} as AbortSignal }),
			).rejects.toThrow(InvalidStagingRequestError);
			await expect(
				withStagedWorkspaceView(
					{ ...request, files: "nope" as unknown as typeof request.files },
					async () => 1,
				),
			).rejects.toThrow(InvalidStagingRequestError);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("reports an adapter-cleaned scratch as already-clean", async () => {
		const { root, files } = await makeRequest();
		try {
			const outcome = await withStagedWorkspaceView({ root, files }, async (view) => {
				expect(await view.cleanup()).toEqual({ status: "cleaned" });
				return 7;
			});
			expect(outcome).toEqual({
				kind: "completed",
				value: 7,
				cleanup: { status: "already-clean" },
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test.skipIf(!IS_POSIX || IS_ROOT)(
		"reports a cleanup failure without masking a completed adapter value",
		async () => {
			const { root, files } = await makeRequest();
			try {
				let scratchDir = "";
				const outcome = await withStagedWorkspaceView({ root, files }, async (view) => {
					scratchDir = view.scratchDir;
					await makeUndeletable(scratchDir);
					return "precious";
				});
				expect(outcome.kind).toBe("completed");
				if (outcome.kind === "completed") {
					expect(outcome.value).toBe("precious");
					expect(outcome.cleanup.status).toBe("failed");
				}
				await releaseDir(scratchDir);
				await rm(scratchDir, { recursive: true, force: true });
				expect(existsSync(scratchDir)).toBe(false);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(!IS_POSIX || IS_ROOT)(
		"reports a cleanup failure without masking an adapter failure",
		async () => {
			const { root, files } = await makeRequest();
			try {
				let scratchDir = "";
				const boom = new Error("adapter exploded");
				const outcome = await withStagedWorkspaceView({ root, files }, async (view) => {
					scratchDir = view.scratchDir;
					await makeUndeletable(scratchDir);
					throw boom;
				});
				const expected: StagedRunOutcome<string> = {
					kind: "adapter-failed",
					error: boom,
					cleanup: { status: "failed", reason: expect.stringContaining("/") },
				};
				expect(outcome).toEqual(expected);
				await releaseDir(scratchDir);
				await rm(scratchDir, { recursive: true, force: true });
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	test("runs a synchronous adapter returning a plain value", async () => {
		const { root, files } = await makeRequest();
		try {
			const outcome = await withStagedWorkspaceView(
				{ root, files },
				((view: StagedWorkspaceView) => view.files.length) as unknown as () => Promise<number>,
			);
			expect(outcome).toEqual({ kind: "completed", value: 1, cleanup: { status: "cleaned" } });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
