/**
 * Cruise coverage-account tests (plan `pl-43c5` step 22 — trellis-adbf):
 * the coverage honesty that makes an empty or partial graph visible —
 * production nodes asserted against the staged selection, stub nodes
 * classified by their own reported fields and preserved separately, and
 * the located, bounded reason a missing-module graph carries.
 */
import { describe, expect, test } from "bun:test";
import type { StagedWorkspaceView } from "../workspace.ts";
import { cruiseCoverage, cruiseOutcomeReason, missingFilesReason } from "./cruise-run.ts";
import type { RawDependencyCruiserReport } from "./raw.ts";

/** A minimal structural staged view (the coverage account reads the selection only). */
function stagedView(paths: readonly string[]): StagedWorkspaceView {
	return {
		files: paths.map((path) => ({
			path,
			stagedPath: path,
			sourceSet: "production" as const,
			packagePath: ".",
			sha256: "0".repeat(64),
			bytes: 0,
		})),
	} as unknown as StagedWorkspaceView;
}

/** One raw module node builder (stub classification reads the module's own fields). */
function moduleNode(source: string, over: Record<string, unknown> = {}) {
	return {
		source,
		dependencies: [],
		dependents: [],
		orphan: false,
		valid: true,
		...over,
	};
}

/** A raw report over the given modules with an empty violation set. */
function reportOver(modules: unknown[]): RawDependencyCruiserReport {
	return {
		modules: modules as RawDependencyCruiserReport["modules"],
		summary: {
			violations: [],
			error: 0,
			warn: 0,
			info: 0,
			ignore: 0,
			totalCruised: modules.length,
			totalDependenciesCruised: 0,
		},
	};
}

describe("cruiseCoverage", () => {
	test("asserts every selection file the reported graph represents, and nothing more", () => {
		const coverage = cruiseCoverage(
			stagedView(["src/b.ts", "src/a.ts"]),
			reportOver([moduleNode("src/a.ts"), moduleNode("src/b.ts")]),
		);
		expect(coverage).toEqual({
			selectedFiles: 2,
			representedFiles: ["src/a.ts", "src/b.ts"],
			missingFiles: [],
			stubs: [],
			totalCruised: 2,
		});
	});

	test("names the selection files a partial graph does not assert — the coverage loss is located", () => {
		const coverage = cruiseCoverage(
			stagedView(["src/a.ts", "src/b.ts", "src/c.ts"]),
			reportOver([moduleNode("src/a.ts")]),
		);
		expect(coverage.representedFiles).toEqual(["src/a.ts"]);
		expect(coverage.missingFiles).toEqual(["src/b.ts", "src/c.ts"]);
		expect(missingFilesReason(coverage)).toContain("does not assert 2 of 3 staged files");
		expect(missingFilesReason(coverage)).toContain('"src/b.ts", "src/c.ts"');
	});

	test("bounds the named missing files in the reason — diagnostics are evidence, not firehoses", () => {
		const paths = Array.from({ length: 9 }, (_, index) => `src/f${index}.ts`);
		const coverage = cruiseCoverage(stagedView(paths), reportOver([]));
		const reason = missingFilesReason(coverage);
		expect(reason).toContain("…and 4 more");
		expect(reason).not.toContain("src/f5.ts");
	});

	test("classifies stub nodes by their own reported fields, never by name guessing", () => {
		const coverage = cruiseCoverage(
			stagedView(["src/a.ts"]),
			reportOver([
				moduleNode("src/a.ts"),
				moduleNode("fs", { coreModule: true }),
				moduleNode("zod", { couldNotResolve: true }),
				moduleNode("./missing.ts", { couldNotResolve: true }),
			]),
		);
		expect(coverage.stubs).toEqual([
			{ source: "./missing.ts", kind: "unresolved-local" },
			{ source: "fs", kind: "builtin" },
			{ source: "zod", kind: "external" },
		]);
	});

	test("treats an empty graph over a non-empty selection as full coverage loss", () => {
		const coverage = cruiseCoverage(stagedView(["src/a.ts"]), reportOver([]));
		expect(coverage.missingFiles).toEqual(["src/a.ts"]);
		expect(coverage.representedFiles).toEqual([]);
		expect(missingFilesReason(coverage)).toContain("successful empty graph");
	});
});

describe("cruiseOutcomeReason", () => {
	test("describes every process outcome kind bounded and without success claims", () => {
		expect(cruiseOutcomeReason({ kind: "exited", exitCode: 1 })).toBe(
			"the provider process exited with code 1",
		);
		expect(cruiseOutcomeReason({ kind: "signaled", signalCode: "SIGKILL" })).toBe(
			"the provider process was terminated by signal SIGKILL",
		);
		expect(cruiseOutcomeReason({ kind: "timeout", reason: "wall-time exceeded" })).toBe(
			"wall-time exceeded",
		);
		expect(cruiseOutcomeReason({ kind: "cancelled", reason: "cancelled by caller" })).toBe(
			"cancelled by caller",
		);
	});
});
