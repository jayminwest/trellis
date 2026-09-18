import { describe, expect, test } from "bun:test";
import type { ControlledProcessOutcome } from "../process.ts";
import type { StagedSelectionFile } from "../staging.ts";
import type { StagedWorkspaceView } from "../workspace.ts";
import { prepareReachabilityContext } from "./context.ts";
import { knipOutcomeReason, reachabilityCoverage, scopeGapReason } from "./knip-run.ts";
import { compileReachabilityPolicy } from "./policy.ts";

/**
 * The reachability pass's own coverage account (plan `pl-43c5` step 24 —
 * trellis-8ebc): the submitted scope, its staging gaps and the observed
 * candidate files are enumerated deterministically, and every process
 * outcome kind is described bounded and without success claims.
 */

/** A minimal structural staged view (the coverage account reads files only). */
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

/** A prepared context over the given selection. */
function contextOf(selection: readonly StagedSelectionFile[]) {
	return prepareReachabilityContext(
		compileReachabilityPolicy({ entries: ["src/main.ts"] }),
		selection,
	);
}

const SELECTION: StagedSelectionFile[] = [
	{ path: "src/main.ts", sourceSet: "production", packagePath: "." },
	{ path: "src/live.ts", sourceSet: "production", packagePath: "." },
	{ path: "src/main.test.ts", sourceSet: "test", packagePath: "." },
];

describe("reachabilityCoverage", () => {
	test("submits the declared scope: roots plus the production candidate scope", () => {
		const view = stagedView(["src/main.ts", "src/live.ts", "src/main.test.ts"]);
		const coverage = reachabilityCoverage(view, contextOf(SELECTION), undefined);
		expect(coverage.scopeFiles).toEqual(["src/live.ts", "src/main.ts"]);
		expect(coverage.missingScopeFiles).toEqual([]);
		expect(coverage.candidateFiles).toEqual([]);
		expect(coverage.issueRows).toBe(0);
	});

	test("names the scope files the staged view could not stage — the coverage loss", () => {
		const view = stagedView(["src/main.ts"]);
		const coverage = reachabilityCoverage(view, contextOf(SELECTION), undefined);
		expect(coverage.missingScopeFiles).toEqual(["src/live.ts"]);
		const reason = scopeGapReason(coverage);
		if (reason === undefined) throw new Error("expected a gap reason");
		expect(reason).toContain("1 submitted scope file(s) could not be staged");
		expect(reason).toContain('"src/live.ts"');
		expect(
			scopeGapReason(reachabilityCoverage(stagedView([]), contextOf(SELECTION), undefined)),
		).toContain("2 submitted scope file(s)");
	});

	test("enumerates the files carrying candidate records, sorted", () => {
		const view = stagedView(["src/main.ts", "src/live.ts"]);
		const coverage = reachabilityCoverage(view, contextOf(SELECTION), {
			issues: [
				{
					file: "src/main.ts",
					exports: [],
					files: [],
					types: [],
					unresolved: [],
				},
				{
					file: "src/live.ts",
					exports: [],
					files: [],
					types: [],
					unresolved: [],
				},
			],
		});
		expect(coverage.candidateFiles).toEqual(["src/live.ts", "src/main.ts"]);
		expect(coverage.issueRows).toBe(2);
	});
});

describe("knipOutcomeReason", () => {
	test("describes every process outcome kind bounded and without success claims", () => {
		const outcomes: ControlledProcessOutcome[] = [
			{ kind: "exited", exitCode: 0 },
			{ kind: "exited", exitCode: 2 },
			{ kind: "signaled", signalCode: "SIGKILL" },
			{ kind: "timeout", reason: "wall-time limit exceeded" },
			{ kind: "cancelled", reason: "cancelled by caller" },
			{ kind: "output-overflow", reason: "stdout exceeded", stream: "stdout" },
			{ kind: "missing-executable", reason: "gone" },
			{ kind: "startup-failed", reason: "nope" },
		];
		const reasons = outcomes.map(knipOutcomeReason);
		expect(reasons[0]).toBe("the provider process exited with code 0");
		expect(reasons[1]).toBe("the provider process exited with code 2");
		expect(reasons[2]).toBe("the provider process was terminated by signal SIGKILL");
		expect(reasons[3]).toBe("wall-time limit exceeded");
		expect(reasons[5]).toBe("stdout exceeded");
	});
});
