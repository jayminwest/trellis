import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CloneMatchMode } from "../../contract/index.ts";
import { analysisIdentitySchema, providerIdentitySchema } from "../../contract/index.ts";
import { pinnedExecutable, type ResolvedExecutable } from "../process.ts";
import { requirePinnedToolExecutable, resolvePinnedTool } from "../resolve.ts";
import { type StagedWorkspaceView, stageWorkspaceView } from "../workspace.ts";
import { JSCPD_DEFAULT_THRESHOLDS } from "./invocation.ts";
import { type JscpdModeOutcome, runJscpdMode } from "./mode-run.ts";

/** Real-binary tests run only where the pinned artifact resolved on this host. */
const TOOL_AVAILABLE = resolvePinnedTool("jscpd").state === "available";

function jscpdExecutable(): ResolvedExecutable {
	return pinnedExecutable("jscpd", requirePinnedToolExecutable("jscpd"));
}

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

/** The spike's renamed variant (identifiers and one literal renamed). */
const RENAMED_FUNCTION = `export function balance(entries: number[], maximum: number): number {
 let subbalance = 0;
 let counted = 0;
 for (const entry of entries) {
  if (entry > maximum) {
   subbalance += entry * 2;
   counted += 1;
  } else {
   subbalance += entry;
  }
 }
 const output = subbalance / Math.max(counted, 1);
 return Math.round(output * 1000) / 1000;
}
`;

/** The spike's near variant (one inserted logging statement). */
const NEAR_FUNCTION = TOTAL_FUNCTION.replace(
	"   subtotal += item * 2;\n",
	"   subtotal += item * 2;\n   console.log(item);\n",
);

/** Stage a real temp workspace with the given files and clean it up after. */
async function withStagedFiles<T>(
	files: Record<string, string>,
	run: (view: StagedWorkspaceView) => Promise<T>,
): Promise<T> {
	const root = await mkdtemp(join(tmpdir(), "trellis-jscpd-mode-run-"));
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
		return await run(view);
	} finally {
		await view.cleanup();
		await rm(root, { recursive: true, force: true });
	}
}

/** Run one mode over staged files through the real pinned binary. */
async function runMode(
	files: Record<string, string>,
	mode: CloneMatchMode,
	prepare?: (view: StagedWorkspaceView) => Promise<void>,
): Promise<JscpdModeOutcome> {
	return withStagedFiles(files, async (view) => {
		await prepare?.(view);
		return runJscpdMode(view, jscpdExecutable(), mode, {
			thresholds: JSCPD_DEFAULT_THRESHOLDS,
			limits: { timeoutMs: 60_000, maxOutputBytes: 1_000_000 },
		});
	});
}

/** Narrow a non-complete outcome for assertions (the expect already failed). */
function incomplete(outcome: JscpdModeOutcome): Extract<JscpdModeOutcome, { state: "incomplete" }> {
	if (outcome.state !== "incomplete") {
		throw new Error(`expected an incomplete outcome, got "${outcome.state}"`);
	}
	return outcome;
}

describe("runJscpdMode (real pinned binary)", () => {
	test.skipIf(!TOOL_AVAILABLE)(
		"reports a small exact pair as complete validated evidence",
		async () => {
			const outcome = await runMode({ "a.ts": TOTAL_FUNCTION, "b.ts": TOTAL_FUNCTION }, "exact");
			expect(outcome.state).toBe("complete");
			if (outcome.state !== "complete") {
				return;
			}
			expect(outcome.report.duplicates).toHaveLength(1);
			expect(outcome.report.duplicates[0]?.kind).toBe("exact");
			expect(outcome.coverage).toEqual({
				selectedFiles: 2,
				reportedSources: 2,
				omittedFromSourceStatistics: 0,
				analyzedFiles: ["a.ts", "b.ts"],
			});
			expect(providerIdentitySchema.parse(outcome.provider)).toEqual(outcome.provider);
			expect(analysisIdentitySchema.parse(outcome.analysis)).toEqual(outcome.analysis);
			expect(outcome.analysis.selection.files.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
			expect(outcome.exitCode).toBe(0);
		},
	);

	test.skipIf(!TOOL_AVAILABLE)("separates renamed evidence under the normalized mode", async () => {
		const outcome = await runMode(
			{ "a.ts": TOTAL_FUNCTION, "b.ts": RENAMED_FUNCTION },
			"normalized",
		);
		expect(outcome.state).toBe("complete");
		if (outcome.state !== "complete") {
			return;
		}
		expect(outcome.report.duplicates).toHaveLength(1);
		expect(outcome.report.duplicates[0]?.kind).toBe("renamed");
		expect(outcome.coverage.analyzedFiles).toEqual(["a.ts", "b.ts"]);
	});

	test.skipIf(!TOOL_AVAILABLE)(
		"separates near-miss evidence with its similarity parameters",
		async () => {
			const outcome = await runMode({ "a.ts": TOTAL_FUNCTION, "b.ts": NEAR_FUNCTION }, "near");
			expect(outcome.state).toBe("complete");
			if (outcome.state !== "complete") {
				return;
			}
			const clone = outcome.report.duplicates[0];
			expect(clone?.kind).toBe("similar");
			expect(clone?.similarity).toBeGreaterThanOrEqual(0.85);
			expect(clone?.method).toBe("ast");
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"accounts for below-threshold files instead of confusing them with coverage",
		async () => {
			const outcome = await runMode(
				{ "a.ts": TOTAL_FUNCTION, "b.ts": TOTAL_FUNCTION, "tiny.ts": "export const x = 1;\n" },
				"exact",
			);
			const gap = incomplete(outcome);
			expect(gap.reason).toContain("omitted from jscpd's source statistics");
			expect(gap.reason).toContain("1 of 3 staged files");
			expect(gap.coverage).toEqual({
				selectedFiles: 3,
				reportedSources: 2,
				omittedFromSourceStatistics: 1,
			});
			expect(gap.coverage?.analyzedFiles).toBeUndefined();
			expect(gap.report?.duplicates).toHaveLength(1);
			expect(gap.exitCode).toBe(0);
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"records a provider error as incomplete with its diagnostics",
		async () => {
			const outcome = await runMode(
				{ "a.ts": TOTAL_FUNCTION, "b.ts": TOTAL_FUNCTION },
				"exact",
				async (view) => {
					// The reporter cannot write its report where a directory occupies the path.
					await mkdir(join(view.workDir, "report-exact", "jscpd-report.json"), { recursive: true });
				},
			);
			const gap = incomplete(outcome);
			expect(gap.exitCode).toBe(1);
			expect(gap.reason).toContain("jscpd exited with code 1");
			expect(gap.reason).toContain("reporter");
			expect(gap.report).toBeUndefined();
		},
	);
});
