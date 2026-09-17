/**
 * Failure regressions for the jscpd provider (plan `pl-43c5` —
 * trellis-b0ec, step 14, acceptance 4): every forced limit and failure
 * surfaces as located `unavailable`/`incomplete` evidence with owned
 * cleanup — never a clean result, never a fabricated report.
 *
 * Forced conditions a healthy pinned binary cannot produce on its own
 * (a malformed JSON report, a schema-violating report, exit 0 without a
 * report) run through a stub at the true external process boundary — the
 * only seam the repo's test conventions allow stubbing — still through
 * the controlled process runner over a staged view. Wall-time and output
 * limits, a missing executable, caller cancellation, the staged-lifecycle
 * wall-time limit, and a scratch-cleanup failure use the real boundaries.
 * Every test cleans its own scratch and temp roots.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinnedExecutable, type ResolvedExecutable, resolveExecutable } from "../process.ts";
import { requirePinnedToolExecutable, resolvePinnedTool } from "../resolve.ts";
import { withStagedWorkspaceView } from "../staged-run.ts";
import { runJscpdAdapter } from "./adapter.ts";
import { fixtureTexts, productionSelection, withConformanceWorkspace } from "./conformance.ts";
import { JSCPD_DEFAULT_THRESHOLDS } from "./invocation.ts";
import { type JscpdModeOutcome, runJscpdMode } from "./mode-run.ts";

/** Real-binary tests run only where the pinned artifact resolved on this host. */
const TOOL_AVAILABLE = resolvePinnedTool("jscpd").state === "available";
const IS_POSIX = process.platform !== "win32";
const IS_ROOT = process.getuid?.() === 0;

/** The identical control pair every failure regression stages. */
const PAIR_FILES: Record<string, string> = fixtureTexts("exact");

/** The resolved pinned jscpd executable of this host. */
function jscpdExecutable(): ResolvedExecutable {
	return pinnedExecutable("jscpd", requirePinnedToolExecutable("jscpd"));
}

/** Run one exact-mode process over the staged control pair under the given limits. */
async function runModeOverPair(
	limits: { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal },
	executable: ResolvedExecutable = jscpdExecutable(),
): Promise<JscpdModeOutcome> {
	return withConformanceWorkspace(PAIR_FILES, (view) =>
		runJscpdMode(view, executable, "exact", { thresholds: JSCPD_DEFAULT_THRESHOLDS, limits }),
	);
}

/** Assert one outcome is a failure state carrying no report (never a clean result). */
function unavailableOf(
	outcome: JscpdModeOutcome,
): Extract<JscpdModeOutcome, { state: "unavailable" | "unsupported" }> {
	if (outcome.state !== "unavailable") {
		throw new Error(`expected an unavailable outcome, got "${outcome.state}"`);
	}
	return outcome;
}

/** A bounded reason fragment every failure outcome carries (never a clean result). */
function reasonOf(outcome: JscpdModeOutcome): string {
	if (outcome.state === "complete") {
		throw new Error(`expected a non-complete outcome, got "${outcome.state}"`);
	}
	return outcome.reason;
}

/** Write a one-file stub provider executable and clean it up after `run`. */
async function withProviderStub<T>(
	name: string,
	body: string,
	run: (executable: ResolvedExecutable) => Promise<T>,
): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "trellis-jscpd-stub-"));
	try {
		const path = join(dir, `${name}.ts`);
		await writeFile(path, `#!${resolveExecutable("bun").path}\n${body}`);
		await chmod(path, 0o755);
		return await run(pinnedExecutable("jscpd", path));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

describe("runJscpdMode failure regressions (limits and executables)", () => {
	test.skipIf(!TOOL_AVAILABLE)(
		"records an exhausted wall-time limit as unavailable, never a clean result",
		async () => {
			const outcome = await runModeOverPair({ timeoutMs: 1, maxOutputBytes: 1_000_000 });
			const unavailable = unavailableOf(outcome);
			expect(unavailable.reason).toContain(
				"wall-time limit of 1ms exceeded; process group terminated",
			);
			expect(Object.hasOwn(unavailable, "report")).toBe(false);
			expect(Object.hasOwn(unavailable, "analysis")).toBe(false);
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"records an exhausted output limit as unavailable, never a clean result",
		async () => {
			const outcome = await runModeOverPair({ timeoutMs: 60_000, maxOutputBytes: 16 });
			const unavailable = unavailableOf(outcome);
			expect(unavailable.reason).toMatch(/exceeded the 16-byte limit/);
			expect(Object.hasOwn(unavailable, "report")).toBe(false);
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"records an unresolvable executable path as unavailable, never a clean result",
		async () => {
			const outcome = await runModeOverPair(
				{ timeoutMs: 60_000, maxOutputBytes: 1_000_000 },
				pinnedExecutable("jscpd", "/nonexistent/jscpd-binary"),
			);
			const unavailable = unavailableOf(outcome);
			expect(unavailable.reason).toContain("ENOENT");
			expect(Object.hasOwn(unavailable, "report")).toBe(false);
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"records caller cancellation before start as unavailable, never a clean result",
		async () => {
			const controller = new AbortController();
			controller.abort();
			const outcome = await runModeOverPair({
				timeoutMs: 60_000,
				maxOutputBytes: 1_000_000,
				signal: controller.signal,
			});
			const unavailable = unavailableOf(outcome);
			expect(unavailable.reason).toContain("cancelled before start; nothing was executed");
			expect(Object.hasOwn(unavailable, "report")).toBe(false);
		},
	);
});

describe("runJscpdMode failure regressions (raw report validation)", () => {
	/** A stub that writes the given report text into the owned output area and exits 0. */
	const reportingStub = (reportText: string) => `
const args = process.argv.slice(2);
const output = args[args.indexOf("--output") + 1];
await Bun.write(output + "/jscpd-report.json", ${JSON.stringify(reportText)});
process.exit(0);
`;

	test.skipIf(!TOOL_AVAILABLE || !IS_POSIX)(
		"records a malformed raw report as incomplete with located reasons",
		async () => {
			await withProviderStub(
				"malformed-report",
				reportingStub("{ not json at all"),
				async (executable) => {
					const outcome = await runModeOverPair(
						{ timeoutMs: 60_000, maxOutputBytes: 1_000_000 },
						executable,
					);
					expect(outcome.state).toBe("incomplete");
					expect(reasonOf(outcome)).toContain("raw jscpd report failed validation");
					expect(reasonOf(outcome)).toContain("not valid JSON");
					expect(Object.hasOwn(outcome, "report")).toBe(false);
				},
			);
		},
	);

	test.skipIf(!TOOL_AVAILABLE || !IS_POSIX)(
		"records a schema-violating raw report as incomplete with located reasons",
		async () => {
			// Valid JSON that violates the pinned tool's report shape: a similar clone
			// without its method and similarity (statistics reconciled with the record).
			const report = JSON.stringify({
				duplicates: [
					{
						firstFile: {
							name: "a.ts",
							start: 1,
							end: 2,
							startLoc: { column: 0, line: 1, position: 0 },
							endLoc: { column: 1, line: 2, position: 0 },
						},
						secondFile: {
							name: "b.ts",
							start: 1,
							end: 2,
							startLoc: { column: 0, line: 1, position: 0 },
							endLoc: { column: 1, line: 2, position: 0 },
						},
						format: "typescript",
						fragment: "x",
						isNew: false,
						kind: "similar",
						lines: 2,
						tokens: 9,
					},
				],
				statistics: {
					detectionDate: "recorded",
					formats: {},
					total: {
						clones: 1,
						duplicatedLines: 2,
						duplicatedTokens: 2,
						lines: 4,
						newClones: 0,
						newDuplicatedLines: 0,
						percentage: 50,
						percentageTokens: 50,
						sources: 2,
						tokens: 4,
					},
				},
			});
			await withProviderStub("schema-violation", reportingStub(report), async (executable) => {
				const outcome = await withConformanceWorkspace(PAIR_FILES, (view) =>
					runJscpdMode(view, executable, "near", {
						thresholds: JSCPD_DEFAULT_THRESHOLDS,
						limits: { timeoutMs: 60_000, maxOutputBytes: 1_000_000 },
					}),
				);
				expect(outcome.state).toBe("incomplete");
				expect(reasonOf(outcome)).toContain("a similar clone must carry its method and similarity");
				expect(Object.hasOwn(outcome, "report")).toBe(false);
			});
		},
	);

	test.skipIf(!TOOL_AVAILABLE || !IS_POSIX)(
		"records an exit-0 run that writes no report as incomplete",
		async () => {
			await withProviderStub("silent-report", "process.exit(0);", async (executable) => {
				const outcome = await runModeOverPair(
					{ timeoutMs: 60_000, maxOutputBytes: 1_000_000 },
					executable,
				);
				expect(outcome.state).toBe("incomplete");
				expect(reasonOf(outcome)).toContain("exited 0 but wrote no readable JSON report");
				expect(Object.hasOwn(outcome, "report")).toBe(false);
			});
		},
	);
});

describe("runJscpdAdapter failure regressions (staged lifecycle)", () => {
	test.skipIf(!TOOL_AVAILABLE)(
		"enforces the wall-time limit through the staged lifecycle with owned cleanup",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "trellis-jscpd-lifecycle-"));
			try {
				await writeFile(join(root, "a.ts"), PAIR_FILES["a.ts"] ?? "");
				await writeFile(join(root, "b.ts"), PAIR_FILES["b.ts"] ?? "");
				let scratchDir = "";
				const run = await withStagedWorkspaceView(
					{ root, files: productionSelection(["a.ts", "b.ts"]) },
					async (view) => {
						scratchDir = view.scratchDir;
						return runJscpdAdapter(view, { modes: ["exact"] });
					},
					{ timeoutMs: 1 },
				);
				// The measurement never scores as clean: the lifecycle stops waiting…
				expect(run.kind).toBe("timeout");
				// …and the owned scratch is cleaned on the timeout exit path.
				expect(run.cleanup).toEqual({ status: "cleaned" });
				expect(existsSync(scratchDir)).toBe(false);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(!TOOL_AVAILABLE || !IS_POSIX || IS_ROOT)(
		"reports a scratch-cleanup failure without masking the adapter evidence",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "trellis-jscpd-cleanup-"));
			let scratchDir = "";
			try {
				await writeFile(join(root, "a.ts"), PAIR_FILES["a.ts"] ?? "");
				await writeFile(join(root, "b.ts"), PAIR_FILES["b.ts"] ?? "");
				const run = await withStagedWorkspaceView(
					{ root, files: productionSelection(["a.ts", "b.ts"]) },
					async (view) => {
						const adapter = await runJscpdAdapter(view, { modes: ["exact"] });
						// An occupied read-only scratch directory cannot be removed by a
						// non-root caller — the cleanup failure to surface.
						scratchDir = view.scratchDir;
						await writeFile(join(view.workDir, "occupant"), "blocker\n");
						await chmod(scratchDir, 0o500);
						return adapter;
					},
					{ timeoutMs: 60_000 },
				);
				expect(run.kind).toBe("completed");
				if (run.kind === "completed") {
					// The complete evidence value wins; the cleanup failure stays visible.
					expect(run.value.outcomes[0]?.state).toBe("complete");
					expect(run.cleanup.status).toBe("failed");
				}
			} finally {
				await chmod(scratchDir, 0o700).catch(() => {});
				await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
				await rm(root, { recursive: true, force: true });
			}
		},
	);
});
