/**
 * Shared fixture workspace and harness for the knip conformance suite (plan
 * `pl-43c5` step 24, trellis-8ebc — acceptance 2–5).
 *
 * The corpus is **authored at test time**: a small labeled reachability
 * workspace (mirroring the research spike's controls —
 * docs/research/architecture-provider-spike) holding every positive case
 * and negative control the adapter must distinguish — used and
 * test-only-used exports, entry-file exports (never candidates), a script
 * entry, a literal dynamic import, a builtin import, an unresolved local
 * import, an unused type, an orphan file, a declared public barrel surface
 * with the implementation files it exposes (a distinct surface, never
 * implied public), a participating and an excluded test file, and a
 * symlinked path inside the audited root (the macOS-alias class of
 * findings). Workspaces exist only inside throwaway temp directories; every
 * real-binary run goes through the delivered boundaries and nothing else:
 * the pinned-tool resolver (`../resolve.ts`), the controlled process runner
 * (`../process.ts`) and a staged source view (`../workspace.ts`) — never a
 * direct knip invocation, never the target workspace, offline, with
 * trellis-owned scratch cleaned on every exit path.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { KnipProviderRequest, SourceSet } from "../../contract/index.ts";
import type { StagedSelectionFile } from "../staging.ts";
import { type StagedWorkspaceView, stageWorkspaceView } from "../workspace.ts";
import { type KnipAdapterResult, runKnipAdapter } from "./adapter.ts";
import type { PreparedReachabilityContext } from "./context.ts";
import { prepareReachabilityContext } from "./context.ts";
import type { KnipNormalizedEvidence } from "./normalize.ts";
import { normalizeKnipReport } from "./normalize.ts";
import { compileReachabilityPolicy } from "./policy.ts";

/**
 * The authored reachability fixture: every module below is one file under
 * `src/`/`scripts/` (repo-relative), with its exact content — the labeled
 * positive cases and negative controls the conformance suite asserts.
 * `src/main.test.ts` is classified `test` by the harness (the audit's own
 * convention), so it participates only where the declared test mode says.
 */
export const REACHABILITY_FIXTURE: Readonly<Record<string, string>> = {
	"src/main.ts":
		'import { used } from "./live.ts";\n' +
		'import { helper } from "./util.ts";\n' +
		'import { readFileSync } from "node:fs";\n' +
		'import "./missing.ts";\n' +
		'import type { Used } from "./types.ts";\n' +
		"export const publicApi = used + helper + readFileSync.name.length;\n" +
		"export const entryOnly: Used = 1;\n" +
		'export const lazy = () => import("./lazy.ts");\n',
	"src/live.ts": "export const used = 1;\nexport const onlyTest = 2;\n",
	"src/util.ts": "export const helper = 3;\n",
	"src/dead.ts": "export const orphan = 0;\n",
	"src/lazy.ts": "export const lazyValue = 4;\n",
	"src/types.ts": "export interface Used { a: number }\nexport interface Unused { b: string }\n",
	"src/index.ts": 'export { impl } from "./impl.ts";\nexport { other } from "./other.ts";\n',
	"src/impl.ts": "export const impl = 5;\nexport const implOnly = 6;\n",
	"src/other.ts": "export const other = 7;\n",
	"src/app.ts": 'import { impl } from "./index.ts";\nexport const app = impl;\n',
	"scripts/tool.ts": 'import { helper } from "../src/util.ts";\nexport const run = helper;\n',
	"src/main.test.ts":
		'import { used, onlyTest } from "./live.ts";\nexport const t = used + onlyTest;\n',
};

/**
 * The conformance request: two declared entries (an application entry and a
 * script), the barrel as a file-level public surface (its re-exports are
 * candidates at the barrel — the implementation files it exposes stay
 * ordinary project files), and tests excluded from evidence.
 */
export const REACHABILITY_REQUEST: KnipProviderRequest = {
	entries: ["src/main.ts", "scripts/tool.ts"],
	public: [{ path: "src/index.ts" }],
	tests: "excluded",
};

/** The same request with the measured test files participating as roots. */
export const REACHABILITY_ROOTS_REQUEST: KnipProviderRequest = {
	entries: ["src/main.ts", "scripts/tool.ts"],
	public: [{ path: "src/index.ts" }],
	tests: "roots",
};

/** The audit's own classification convention for the fixture's files. */
export function fixtureSourceSet(path: string): SourceSet {
	return path.endsWith(".test.ts") ? "test" : "production";
}

/** Selection entries for the given repo-relative paths, classified by convention. */
export function fixtureSelection(paths: readonly string[]): StagedSelectionFile[] {
	return paths.map((path) => ({
		path,
		sourceSet: fixtureSourceSet(path),
		packagePath: ".",
	}));
}

/**
 * Stage a fresh no-dependency, non-Git conformance workspace holding exactly
 * `files` (with every directory of `aliases` created as an in-root symlink
 * first, so a selection path can traverse an aliased directory — the
 * macOS-alias class of findings), run `run` with the staged view and the
 * workspace root, and clean both on every exit path.
 */
export async function withReachabilityWorkspace<T>(
	files: Readonly<Record<string, string>>,
	run: (view: StagedWorkspaceView, root: string) => Promise<T>,
	aliases: Readonly<Record<string, string>> = {},
): Promise<T> {
	const root = await mkdtemp(join(tmpdir(), "trellis-reachability-conformance-"));
	try {
		for (const [link, target] of Object.entries(aliases)) {
			await mkdir(dirname(join(root, link)), { recursive: true });
			await mkdir(join(root, target), { recursive: true });
			await symlink(join(root, target), join(root, link), "dir");
		}
		for (const [path, source] of Object.entries(files)) {
			await mkdir(dirname(join(root, path)), { recursive: true });
			await writeFile(join(root, path), source);
		}
		const view = await stageWorkspaceView({ root, files: fixtureSelection(Object.keys(files)) });
		try {
			return await run(view, root);
		} finally {
			await view.cleanup();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

/** The prepared reachability context of one request over the fixture selection. */
export function preparedFixtureContext(
	request: KnipProviderRequest = REACHABILITY_REQUEST,
): PreparedReachabilityContext {
	return prepareReachabilityContext(
		compileReachabilityPolicy(request),
		fixtureSelection(Object.keys(REACHABILITY_FIXTURE)),
	);
}

/** One conformance adapter run over a fresh staged workspace of `files`. */
export interface ReachabilityConformanceRun {
	adapter: KnipAdapterResult;
	/** The normalized evidence of the pass, when its outcome carried a raw report. */
	normalized: KnipNormalizedEvidence | undefined;
}

/** Run the adapter over a fresh staged workspace of `files` under `request`. */
export async function runReachabilityConformance(
	files: Readonly<Record<string, string>> = REACHABILITY_FIXTURE,
	request: KnipProviderRequest = REACHABILITY_REQUEST,
	aliases: Readonly<Record<string, string>> = {},
): Promise<ReachabilityConformanceRun> {
	return withReachabilityWorkspace(
		files,
		async (view) => {
			const context = prepareReachabilityContext(
				compileReachabilityPolicy(request),
				view.files.map((file) => ({ path: file.path, sourceSet: file.sourceSet })),
			);
			const adapter = await runKnipAdapter(view, context);
			const outcome = adapter.outcome;
			if (outcome.state !== "complete" && outcome.state !== "incomplete") {
				return { adapter, normalized: undefined };
			}
			if (!("report" in outcome) || outcome.report === undefined) {
				return { adapter, normalized: undefined };
			}
			return { adapter, normalized: normalizeKnipReport(outcome.report, context) };
		},
		aliases,
	);
}

/** Narrow a conformance run's outcome to its complete variant. */
export function requireCompletePass(run: ReachabilityConformanceRun): {
	adapter: KnipAdapterResult;
	normalized: KnipNormalizedEvidence;
} {
	const outcome = run.adapter.outcome;
	if (outcome.state !== "complete") {
		throw new Error(`expected the pass to complete, got "${outcome.state}": ${outcome.reason}`);
	}
	if (run.normalized === undefined) {
		throw new Error("expected normalized evidence from the completed pass");
	}
	return { adapter: run.adapter, normalized: run.normalized };
}
