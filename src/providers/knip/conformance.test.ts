/**
 * Bounded conformance for the knip provider over the authored reachability
 * controls (plan `pl-43c5` step 24, trellis-8ebc — acceptance 2–5).
 *
 * Every control runs through the real pinned tool over a staged view —
 * resolver → controlled process runner → staged workspace — and asserts
 * **explicit expected candidate sets**: the four categories stay apart,
 * entry-file exports are never candidates, a literal dynamic import keeps
 * its target reachable, a builtin import is never unresolved, excluded
 * tests supply no reachability evidence while participating test roots do,
 * a declared public barrel surface is a distinct surface from the
 * implementation it exposes (in both directions), an aliased selection
 * path (the macOS-alias class) completes over its declared path, and
 * repeat runs normalize byte-identically. Nothing here scores evidence or
 * displaces the native analyzers; candidates are contextual, never
 * confirmed dead code.
 */
import { describe, expect, test } from "bun:test";
import { resolvePinnedTool } from "../resolve.ts";
import { runKnipAdapter } from "./adapter.ts";
import {
	REACHABILITY_FIXTURE,
	REACHABILITY_ROOTS_REQUEST,
	type ReachabilityConformanceRun,
	requireCompletePass,
	runReachabilityConformance,
	withReachabilityWorkspace,
} from "./conformance.ts";
import { prepareReachabilityContext } from "./context.ts";
import { compileReachabilityPolicy } from "./policy.ts";

/** Real-binary tests run only where the pinned artifact resolved on this host. */
const TOOL_AVAILABLE = resolvePinnedTool("knip").state === "available";

/** One run's compact candidate projection: category, path, symbol. */
function candidatesOf(run: ReachabilityConformanceRun): string[] {
	const completed = requireCompletePass(run);
	return completed.normalized.candidates.map(
		(candidate) => `${candidate.category}:${candidate.path}:${candidate.symbol ?? ""}`,
	);
}

/** The symbols that must never be candidates (the negative controls). */
const NEVER_CANDIDATES = [
	"export:src/main.ts:publicApi",
	"export:src/main.ts:entryOnly",
	"export:src/live.ts:used",
	"export:src/util.ts:helper",
	"export:src/lazy.ts:lazyValue",
	"type:src/types.ts:Used",
	"file:src/main.ts:",
	"file:src/util.ts:",
	"file:src/lazy.ts:",
	"file:src/types.ts:",
	"file:src/scripts/tool.ts:",
	"file:src/main.test.ts:",
	"unresolved:src/main.ts:node:fs",
];

describe("runKnipAdapter conformance (pinned controls)", () => {
	test.skipIf(!TOOL_AVAILABLE)(
		"distinguishes orphan files, unused exports, unused types and unresolved imports exactly",
		async () => {
			const run = await runReachabilityConformance();
			const { adapter, normalized } = requireCompletePass(run);
			expect(adapter.outcome.state).toBe("complete");
			expect(candidatesOf(run)).toEqual([
				"file:src/app.ts:",
				"file:src/dead.ts:",
				"file:src/impl.ts:",
				"export:src/live.ts:onlyTest",
				"unresolved:src/main.ts:./missing.ts",
				"file:src/other.ts:",
				"type:src/types.ts:Unused",
			]);
			for (const forbidden of NEVER_CANDIDATES) {
				expect(candidatesOf(run)).not.toContain(forbidden);
			}
			// Entry exports and the literal dynamic import keep their files
			// reachable — negative controls, not findings.
			expect(normalized.candidates.some((candidate) => candidate.path === "src/lazy.ts")).toBe(
				false,
			);
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"records the manifest pin, the resolved platform and the tool's own parser per run",
		async () => {
			const run = await runReachabilityConformance();
			const { adapter } = requireCompletePass(run);
			expect(adapter.toolVersion).toBe("6.16.1");
			expect(adapter.resolution.state).toBe("available");
			expect("version" in adapter.parser).toBe(true);
			expect(adapter.disabledPlugins).toBeGreaterThan(100);
			const outcome = adapter.outcome;
			if (outcome.state !== "complete") throw new Error("expected a complete pass");
			expect(outcome.provider.toolVersion).toBe("6.16.1");
			expect(outcome.provider.mode).toBe("contextual");
			expect(outcome.analysis.parser.engine).toBe("knip.oxc-parser");
			// The staged view carries the whole fixture (the adapter-level
			// harness stages every fixture file); the analysis-level fold
			// stages exactly the context's scope (see analysis.test.ts).
			expect(outcome.analysis.selection.sourceSets).toEqual(["production", "test"]);
			expect(outcome.coverage.scopeFiles).toEqual(
				Object.keys(REACHABILITY_FIXTURE)
					.filter((path) => !path.endsWith(".test.ts"))
					.sort(),
			);
			expect(outcome.coverage.missingScopeFiles).toEqual([]);
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"exempts declared public-surface candidates as visible evidence, never silently",
		async () => {
			const run = await runReachabilityConformance();
			const { normalized } = requireCompletePass(run);
			expect(normalized.exemptions).toEqual([
				{ surface: "src/index.ts", category: "file", path: "src/index.ts" },
			]);
			const exemption = normalized.findings.find(
				(finding) => finding.kind === "provider.knip.public-surface",
			);
			expect(exemption?.summary).toContain("'src/index.ts'");
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"treats a public barrel as a distinct surface from the implementation it exposes",
		async () => {
			// With the barrel's consumer declared an entry, the barrel is
			// referenced: its own unused re-export is a candidate at the barrel
			// (exempted by the file-level surface), while the implementation's
			// own unused exports stay candidates at their files — in both
			// directions, the surface never rewrites to the implementation.
			const run = await runReachabilityConformance(REACHABILITY_FIXTURE, {
				entries: ["src/main.ts", "scripts/tool.ts", "src/app.ts"],
				public: [{ path: "src/index.ts" }],
				tests: "excluded",
			});
			expect(candidatesOf(run)).toEqual([
				"file:src/dead.ts:",
				"export:src/impl.ts:implOnly",
				"export:src/live.ts:onlyTest",
				"unresolved:src/main.ts:./missing.ts",
				"export:src/other.ts:other",
				"type:src/types.ts:Unused",
			]);
			const { normalized } = requireCompletePass(run);
			expect(normalized.exemptions.map((exemption) => exemption.category)).toEqual(["export"]);
			expect(normalized.exemptions[0]?.path).toBe("src/index.ts");
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"excluded tests supply no reachability evidence; participating test roots do",
		async () => {
			const excluded = requireCompletePass(await runReachabilityConformance());
			expect(
				excluded.normalized.candidates.some(
					(candidate) => candidate.path === "src/live.ts" && candidate.symbol === "onlyTest",
				),
			).toBe(true);
			expect(
				excluded.normalized.assumptions.some((assumption) => assumption.id === "tests-excluded"),
			).toBe(true);

			const roots = requireCompletePass(
				await runReachabilityConformance(REACHABILITY_FIXTURE, REACHABILITY_ROOTS_REQUEST),
			);
			expect(roots.normalized.candidates.some((candidate) => candidate.symbol === "onlyTest")).toBe(
				false,
			);
			expect(roots.normalized.assumptions.some((a) => a.id === "tests-excluded")).toBe(false);
			// The participating test file stays outside the production scope
			// and is never a candidate itself.
			expect(
				roots.normalized.candidates.some((candidate) => candidate.path === "src/main.test.ts"),
			).toBe(false);
			const scope = roots.normalized.metrics.find(
				(metric) => metric.id === "provider.knip.scope.files",
			);
			expect(scope?.detail).toMatchObject({ testRoots: 1 });
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"a request with no declared entries leaves reachability undefined — every file a contextual candidate",
		async () => {
			const run = await runReachabilityConformance(REACHABILITY_FIXTURE, {});
			const { normalized } = requireCompletePass(run);
			const files = normalized.candidates.filter((candidate) => candidate.category === "file");
			expect(files.map((candidate) => candidate.path)).toEqual(
				Object.keys(REACHABILITY_FIXTURE)
					.filter((path) => !path.endsWith(".test.ts"))
					.sort(),
			);
			for (const id of ["no-entries-declared", "no-public-surfaces-declared"]) {
				expect(normalized.assumptions.some((assumption) => assumption.id === id)).toBe(true);
			}
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"completes over an aliased selection path (the macOS-alias class of findings)",
		async () => {
			const files = {
				"src/alias/aliased.ts": "export const aliased = 1;\nexport const aliasUnused = 2;\n",
				"src/main.ts":
					'import { aliased } from "./alias/aliased.ts";\nexport const publicApi = aliased;\n',
			};
			const run = await withReachabilityWorkspace(
				files,
				async (view) => {
					const context = prepareReachabilityContext(
						compileReachabilityPolicy({ entries: ["src/main.ts"] }),
						view.files.map((file) => ({ path: file.path, sourceSet: file.sourceSet })),
					);
					return runKnipAdapter(view, context);
				},
				{ "src/alias": "src/real" },
			);
			expect(run.outcome.state).toBe("complete");
			if (run.outcome.state !== "complete") throw new Error("expected a complete pass");
			// The candidate carries the declared (aliased) selection path.
			expect(run.outcome.report.issues.map((row) => row.file)).toEqual(["src/alias/aliased.ts"]);
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"normalizes repeat runs byte-identically despite the tool's nondeterministic row order",
		async () => {
			const first = requireCompletePass(await runReachabilityConformance());
			const second = requireCompletePass(await runReachabilityConformance());
			expect(JSON.stringify(first.normalized)).toBe(JSON.stringify(second.normalized));
			if (
				first.adapter.outcome.state !== "complete" ||
				second.adapter.outcome.state !== "complete"
			) {
				throw new Error("expected complete passes");
			}
			expect(JSON.stringify(first.adapter.outcome.coverage)).toBe(
				JSON.stringify(second.adapter.outcome.coverage),
			);
		},
	);
});
