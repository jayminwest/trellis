/**
 * Bounded failure regressions for the knip provider (plan `pl-43c5` step 24
 * — trellis-8ebc, acceptance 4): every way a pass can fail to produce
 * trustworthy evidence — exhausted process limits, an unusable scratch
 * manifest collision, a malformed or foreign raw report, a tool that cannot
 * run its analysis, an **empty or partial analysis** (the research record's
 * central failure, surfaced through the exit-code protocol), and a staged
 * scope the generated configuration cannot fully submit — yields its
 * explicit located status, never a clean pass with zero candidates.
 *
 * Failure shapes the real pinned tool cannot be made to produce run through
 * a stub at the true external process boundary — the only seam the repo's
 * test conventions allow stubbing — still through the controlled process
 * runner and a real staged view. Every stub is a plain script that ignores
 * its arguments and prints or exits; nothing re-implements the tool. A
 * stubbed clean zero (exit `0`, empty issues, coherent scope) is also
 * pinned: a legitimate complete zero — and zero findings never proves
 * overall quality.
 */
import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pinnedExecutable, type ResolvedExecutable, resolveExecutable } from "../process.ts";
import { resolvePinnedTool } from "../resolve.ts";
import type { StagedSelectionFile } from "../staging.ts";
import { type StagedWorkspaceView, stageWorkspaceView } from "../workspace.ts";
import { REACHABILITY_FIXTURE, REACHABILITY_REQUEST } from "./conformance.ts";
import { prepareReachabilityContext } from "./context.ts";
import { type KnipOutcome, runKnipReachabilityPass } from "./knip-run.ts";
import { compileReachabilityPolicy } from "./policy.ts";
import { disabledPluginNames } from "./tool-config.ts";

/** Real-binary tests run only where the pinned artifact resolved on this host. */
const TOOL_AVAILABLE = resolvePinnedTool("knip").state === "available";

/** The real pinned launcher invocation, for the stubs to pair with. */
function realInvocation():
	| { interpreter: ResolvedExecutable; launcher: ResolvedExecutable }
	| undefined {
	const resolution = resolvePinnedTool("knip");
	if (resolution.state !== "available") return undefined;
	return {
		interpreter: resolveExecutable("bun"),
		launcher: pinnedExecutable("knip", resolution.executablePath),
	};
}

/** The plugin names the generated configuration would disable. */
function pluginNames(): string[] {
	const resolution = resolvePinnedTool("knip");
	if (resolution.state !== "available") throw new Error("the pinned knip did not resolve");
	const packageRoot = resolution.executablePath.replace(/\/bin\/[^/]+$/, "");
	const plugins = disabledPluginNames(packageRoot);
	if ("state" in plugins) throw new Error(plugins.reason);
	return plugins.names;
}

/** A prepared context over the given selection paths. */
async function contextOver(
	paths: readonly string[],
): Promise<ReturnType<typeof prepareReachabilityContext>> {
	const selection: StagedSelectionFile[] = paths.map((path) => ({
		path,
		sourceSet: "production" as const,
		packagePath: ".",
	}));
	return prepareReachabilityContext(compileReachabilityPolicy(REACHABILITY_REQUEST), selection);
}

/** Stage a fresh fixture workspace view and clean it after `run`. */
async function withFixtureView<T>(
	selection: readonly StagedSelectionFile[],
	run: (view: StagedWorkspaceView) => Promise<T>,
): Promise<T> {
	const root = await mkdtemp(join(tmpdir(), "trellis-knip-failures-"));
	try {
		for (const [path, source] of Object.entries(REACHABILITY_FIXTURE)) {
			await mkdir(dirname(join(root, path)), { recursive: true });
			await writeFile(join(root, path), source);
		}
		const view = await stageWorkspaceView({ root, files: selection });
		try {
			return await run(view);
		} finally {
			await view.cleanup();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

/** Pair a stub interpreter with the real pinned launcher (fails fast when the pin did not resolve). */
function pairedInvocation(interpreter: ResolvedExecutable): {
	interpreter: ResolvedExecutable;
	launcher: ResolvedExecutable;
} {
	const built = realInvocation();
	if (built === undefined) throw new Error("the pinned knip did not resolve");
	return { interpreter, launcher: built.launcher };
}

/** Run one pass over a real staged fixture view under the given interpreter and limits. */
async function runPass(
	selection: readonly StagedSelectionFile[],
	limits: { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal },
	invocation?: { interpreter: ResolvedExecutable; launcher: ResolvedExecutable },
	contextPaths?: readonly string[],
): Promise<KnipOutcome> {
	const built = invocation ?? realInvocation();
	if (built === undefined) throw new Error("the pinned knip did not resolve");
	const context = await contextOver(contextPaths ?? selection.map((file) => file.path));
	return withFixtureView(selection, async (view) =>
		runKnipReachabilityPass(view, context, built, pluginNames(), "0.133.0-test", limits),
	);
}

/** The incomplete variant of an outcome, fails fast otherwise. */
function incompleteOf(outcome: KnipOutcome): Extract<KnipOutcome, { state: "incomplete" }> {
	if (outcome.state === "incomplete") return outcome;
	throw new Error(`expected an incomplete outcome, got "${outcome.state}"`);
}

/** The unavailable variant of an outcome, fails fast otherwise. */
function unavailableOf(
	outcome: KnipOutcome,
): Extract<KnipOutcome, { state: "unavailable" | "unsupported" }> {
	if (outcome.state !== "complete" && outcome.state !== "incomplete") return outcome;
	throw new Error(`expected a never-ran outcome, got "${outcome.state}"`);
}

/** Write a one-file stub provider executable and clean it up after `run`. */
async function withInterpreterStub<T>(
	name: string,
	body: string,
	run: (interpreter: ResolvedExecutable) => Promise<T>,
): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "trellis-knip-stub-"));
	try {
		const path = join(dir, `${name}.ts`);
		await writeFile(path, `#!${resolveExecutable("bun").path}\n${body}`);
		await chmod(path, 0o755);
		return await run(pinnedExecutable("knip-stub", path));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** The staged fixture production selection (no test file). */
const PRODUCTION: StagedSelectionFile[] = Object.keys(REACHABILITY_FIXTURE)
	.filter((path) => !path.endsWith(".test.ts"))
	.map((path) => ({ path, sourceSet: "production" as const, packagePath: "." }));

describe("runKnipReachabilityPass failure regressions (limits and executables)", () => {
	test.skipIf(!TOOL_AVAILABLE)(
		"records an exhausted wall-time limit as unavailable, never a clean result",
		async () => {
			const outcome = await runPass(PRODUCTION, { timeoutMs: 1, maxOutputBytes: 1_000_000 });
			expect(unavailableOf(outcome).reason).toContain("wall-time limit of 1ms exceeded");
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"records an exhausted output limit as unavailable, never a clean result",
		async () => {
			const outcome = await runPass(PRODUCTION, { timeoutMs: 60_000, maxOutputBytes: 16 });
			expect(unavailableOf(outcome).reason).toContain("exceeded the 16-byte limit");
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"a malformed raw report is incomplete with its located reason, never clean evidence",
		async () => {
			const outcome = await withInterpreterStub(
				"malformed",
				"console.log('{\"issues\": [');",
				async (interpreter) =>
					runPass(
						PRODUCTION,
						{ timeoutMs: 60_000, maxOutputBytes: 4_000_000 },
						{
							interpreter,
							launcher: pairedInvocation(interpreter).launcher,
						},
					),
			);
			const incomplete = incompleteOf(outcome);
			expect(incomplete.reason).toContain("raw knip report failed validation");
			expect(incomplete.reason).toContain("not valid JSON");
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"a foreign report row is suspect evidence — incomplete, never a finding",
		async () => {
			const outcome = await withInterpreterStub(
				"foreign",
				'console.log(JSON.stringify({issues: [{file: "src/foreign.ts", exports: [], files: [], types: [], unresolved: []}]}));',
				async (interpreter) =>
					runPass(
						PRODUCTION,
						{ timeoutMs: 60_000, maxOutputBytes: 4_000_000 },
						{
							interpreter,
							launcher: pairedInvocation(interpreter).launcher,
						},
					),
			);
			const incomplete = incompleteOf(outcome);
			expect(incomplete.reason).toContain("suspect evidence");
			expect(incomplete.reason).toContain("outside the staged selection");
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"a tool that cannot run its analysis is incomplete with its bounded diagnostics",
		async () => {
			const outcome = await withInterpreterStub(
				"broken",
				'console.error("ERROR: unable to load configuration");\nprocess.exit(2);',
				async (interpreter) =>
					runPass(
						PRODUCTION,
						{ timeoutMs: 60_000, maxOutputBytes: 4_000_000 },
						{
							interpreter,
							launcher: pairedInvocation(interpreter).launcher,
						},
					),
			);
			const incomplete = incompleteOf(outcome);
			expect(incomplete.reason).toContain("could not run its analysis (exit code 2)");
			expect(incomplete.reason).toContain("unable to load configuration");
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"a configuration-hint exit is an empty or partial analysis — incomplete, report attached",
		async () => {
			const outcome = await withInterpreterStub(
				"hints",
				"console.log(JSON.stringify({issues: []}));\nprocess.exit(1);",
				async (interpreter) =>
					runPass(
						PRODUCTION,
						{ timeoutMs: 60_000, maxOutputBytes: 4_000_000 },
						{
							interpreter,
							launcher: pairedInvocation(interpreter).launcher,
						},
					),
			);
			const incomplete = incompleteOf(outcome);
			expect(incomplete.reason).toContain("configuration hints");
			expect(incomplete.reason).toContain("never a clean pass");
			expect(incomplete.report?.issues).toEqual([]);
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"a clean zero over a coherent scope is complete — and zero findings never proves quality",
		async () => {
			const outcome = await withInterpreterStub(
				"zero",
				"console.log(JSON.stringify({issues: []}));",
				async (interpreter) =>
					runPass(
						PRODUCTION,
						{ timeoutMs: 60_000, maxOutputBytes: 4_000_000 },
						{
							interpreter,
							launcher: pairedInvocation(interpreter).launcher,
						},
					),
			);
			if (outcome.state !== "complete") throw new Error(outcome.reason);
			expect(outcome.report.issues).toEqual([]);
		},
	);
});

describe("runKnipReachabilityPass scope regressions", () => {
	test.skipIf(!TOOL_AVAILABLE)(
		"a staged scope the configuration cannot fully submit is incomplete — the real tool reports the hint",
		async () => {
			// The context declares a scope over a selection whose extra file the
			// staged view does not carry: the generated configuration submits a
			// pattern with no staged file, the real pinned tool exits with a
			// configuration hint, and the pass is an incomplete analysis of the
			// declared scope — never a clean pass.
			const staged: StagedSelectionFile[] = PRODUCTION.filter(
				(file) => file.path !== "src/dead.ts",
			);
			const outcome = await runPass(
				staged,
				{ timeoutMs: 60_000, maxOutputBytes: 4_000_000 },
				undefined,
				PRODUCTION.map((file) => file.path),
			);
			const incomplete = incompleteOf(outcome);
			expect(incomplete.reason).toContain("configuration hints");
			expect(incomplete.reason).toContain("1 submitted scope file(s) could not be staged");
			expect(incomplete.reason).toContain('"src/dead.ts"');
			expect(incomplete.coverage?.missingScopeFiles).toEqual(["src/dead.ts"]);
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"refuses a staged view that already carries a package manifest — the source-only invariant",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "trellis-knip-manifest-"));
			try {
				await writeFile(join(root, "package.json"), "{}");
				await mkdir(join(root, "src"), { recursive: true });
				await writeFile(join(root, "src/main.ts"), "export const main = 1;\n");
				const selection: StagedSelectionFile[] = [
					{ path: "package.json", sourceSet: "production", packagePath: "." },
					{ path: "src/main.ts", sourceSet: "production", packagePath: "." },
				];
				const view = await stageWorkspaceView({ root, files: selection });
				try {
					const built = realInvocation();
					if (built === undefined) throw new Error("the pinned knip did not resolve");
					const outcome = await runKnipReachabilityPass(
						view,
						await contextOver(["package.json", "src/main.ts"]),
						built,
						pluginNames(),
						"0.133.0-test",
						{ timeoutMs: 60_000, maxOutputBytes: 4_000_000 },
					);
					expect(unavailableOf(outcome).reason).toContain(
						"unexpectedly carries a package manifest",
					);
				} finally {
					await view.cleanup();
				}
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);
});
