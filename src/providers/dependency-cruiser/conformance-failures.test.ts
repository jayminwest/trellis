/**
 * Bounded failure regressions for the dependency-cruiser provider (plan
 * `pl-43c5` step 22 — trellis-adbf, acceptance 4): every way a cruise can
 * fail to produce trustworthy evidence — exhausted process limits, a
 * missing launcher, a silent exit, a malformed or foreign raw report, a
 * **successful empty graph** (the research record's central failure), an
 * empty staged selection, a missing local TypeScript parser, a staging
 * failure, an invalid request and the lifecycle's own wall-time limit —
 * yields its explicit located status, never a clean pass with zero
 * violations.
 *
 * Failure shapes the real pinned tool cannot be made to produce (it
 * validates its own generated configuration) run through a stub at the
 * true external process boundary — the only seam the repo's test
 * conventions allow stubbing — still through the controlled process
 * runner and a real staged view. Every stub is a plain script that
 * ignores its arguments and prints or exits; nothing re-implements the
 * tool.
 */
import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinnedExecutable, type ResolvedExecutable, resolveExecutable } from "../process.ts";
import { resolvePinnedTool } from "../resolve.ts";
import {
	ARCHITECTURE_FIXTURE,
	ARCHITECTURE_REQUEST,
	withArchitectureWorkspace,
} from "./conformance.ts";
import { type DependencyCruiserOutcome, runDependencyCruiserCruise } from "./cruise-run.ts";
import { compileArchitecturePolicy } from "./policy.ts";

/** Real-binary tests run only where the pinned artifact resolved on this host. */
const TOOL_AVAILABLE = resolvePinnedTool("dependency-cruiser").state === "available";
const IS_POSIX = process.platform !== "win32";

/** The policy the failure regressions evaluate. */
const POLICY = compileArchitecturePolicy(ARCHITECTURE_REQUEST);

/** The real pinned launcher invocation, for the stubs to replace. */
function realInvocation():
	| { interpreter: ResolvedExecutable; launcher: ResolvedExecutable }
	| undefined {
	const resolution = resolvePinnedTool("dependency-cruiser");
	if (resolution.state !== "available") return undefined;
	const interpreter = resolveExecutable("bun");
	return {
		interpreter,
		launcher: pinnedExecutable("dependency-cruiser", resolution.executablePath),
	};
}

/** Run one cruise over a real staged fixture workspace under the given limits and invocation. */
async function runCruise(
	limits: { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal },
	invocation?: { interpreter: ResolvedExecutable; launcher: ResolvedExecutable },
): Promise<DependencyCruiserOutcome> {
	const built = invocation ?? realInvocation();
	if (built === undefined) throw new Error("the pinned dependency-cruiser did not resolve");
	return withArchitectureWorkspace(ARCHITECTURE_FIXTURE, (view) =>
		runDependencyCruiserCruise(view, POLICY, built, "0.0.0-test", limits),
	);
}

/** The unavailable variant of an outcome, fails fast otherwise. */
function unavailableOf(
	outcome: DependencyCruiserOutcome,
): Extract<DependencyCruiserOutcome, { state: "unavailable" | "unsupported" }> {
	if (outcome.state !== "complete" && outcome.state !== "incomplete") return outcome;
	throw new Error(`expected a never-ran outcome, got "${outcome.state}"`);
}

/** The incomplete variant of an outcome, fails fast otherwise. */
function incompleteOf(
	outcome: DependencyCruiserOutcome,
): Extract<DependencyCruiserOutcome, { state: "incomplete" }> {
	if (outcome.state === "incomplete") return outcome;
	throw new Error(`expected an incomplete outcome, got "${outcome.state}"`);
}

/** A stub interpreter paired with the real pinned launcher (fails fast when the pin did not resolve). */
function withLauncher(interpreter: ResolvedExecutable): {
	interpreter: ResolvedExecutable;
	launcher: ResolvedExecutable;
} {
	const built = realInvocation();
	if (built === undefined) throw new Error("the pinned dependency-cruiser did not resolve");
	return { interpreter, launcher: built.launcher };
}

/** Write a one-file stub provider executable and clean it up after `run`. */
async function withInterpreterStub<T>(
	name: string,
	body: string,
	run: (interpreter: ResolvedExecutable) => Promise<T>,
): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "trellis-dc-stub-"));
	try {
		const path = join(dir, `${name}.ts`);
		await writeFile(path, `#!${resolveExecutable("bun").path}\n${body}`);
		await chmod(path, 0o755);
		return await run(pinnedExecutable("dependency-cruiser-stub", path));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

describe("runDependencyCruiserCruise failure regressions (limits and executables)", () => {
	test.skipIf(!TOOL_AVAILABLE)(
		"records an exhausted wall-time limit as unavailable, never a clean result",
		async () => {
			const outcome = await runCruise({ timeoutMs: 1, maxOutputBytes: 1_000_000 });
			expect(unavailableOf(outcome).reason).toContain(
				"wall-time limit of 1ms exceeded; process group terminated",
			);
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"records an exhausted output limit as unavailable, never a clean result",
		async () => {
			const outcome = await runCruise({ timeoutMs: 60_000, maxOutputBytes: 16 });
			expect(unavailableOf(outcome).reason).toMatch(/exceeded the 16-byte limit/);
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"records an unresolvable interpreter as unavailable, never a clean result",
		async () => {
			const outcome = await runCruise(
				{ timeoutMs: 60_000, maxOutputBytes: 1_000_000 },
				{
					interpreter: pinnedExecutable("dependency-cruiser-stub", "/nonexistent/interpreter"),
					launcher:
						realInvocation()?.launcher ?? pinnedExecutable("dependency-cruiser", "/launcher"),
				},
			);
			expect(unavailableOf(outcome).reason).toContain("ENOENT");
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"records caller cancellation before start as unavailable, never a clean result",
		async () => {
			const controller = new AbortController();
			controller.abort();
			const outcome = await runCruise({
				timeoutMs: 60_000,
				maxOutputBytes: 1_000_000,
				signal: controller.signal,
			});
			expect(unavailableOf(outcome).reason).toContain(
				"cancelled before start; nothing was executed",
			);
		},
	);
});

describe("runDependencyCruiserCruise failure regressions (raw report validation)", () => {
	/** A stub interpreter that prints the given stdout and exits with the given code. */
	const stdoutStub = (stdout: string, exitCode = 0, stderr = "") =>
		`process.stderr.write(${JSON.stringify(stderr)});process.stdout.write(${JSON.stringify(stdout)});process.exit(${exitCode});`;

	test.skipIf(!TOOL_AVAILABLE || !IS_POSIX)(
		"records a non-zero exit with its diagnostics as incomplete, never a clean result",
		async () => {
			await withInterpreterStub(
				"exit-diagnostics",
				stdoutStub("", 3, "error TS18003: no inputs"),
				async (interpreter) => {
					const outcome = await runCruise(
						{ timeoutMs: 60_000, maxOutputBytes: 1_000_000 },
						withLauncher(interpreter),
					);
					const incomplete = incompleteOf(outcome);
					expect(incomplete.reason).toContain("exited with code 3");
					expect(incomplete.reason).toContain("error TS18003");
				},
			);
		},
	);

	test.skipIf(!TOOL_AVAILABLE || !IS_POSIX)(
		"records a malformed raw report as incomplete with located reasons",
		async () => {
			await withInterpreterStub(
				"malformed-report",
				stdoutStub("{ not json"),
				async (interpreter) => {
					const outcome = await runCruise(
						{ timeoutMs: 60_000, maxOutputBytes: 1_000_000 },
						withLauncher(interpreter),
					);
					expect(incompleteOf(outcome).reason).toContain("not valid JSON");
				},
			);
		},
	);

	test.skipIf(!TOOL_AVAILABLE || !IS_POSIX)(
		"records a foreign rule in a schema-valid report as suspect evidence, never findings",
		async () => {
			const report = JSON.stringify({
				modules: [
					{
						source: "src/main.ts",
						dependencies: [],
						dependents: [],
						orphan: false,
						valid: true,
					},
				],
				summary: {
					violations: [
						{
							type: "dependency",
							rule: { severity: "error", name: "foreign-rule" },
							from: "src/main.ts",
							to: "./gone.ts",
							unresolvedTo: "./gone.ts",
							dependencyTypes: ["unknown"],
						},
					],
					error: 1,
					warn: 0,
					info: 0,
					ignore: 0,
					totalCruised: 1,
					totalDependenciesCruised: 1,
				},
			});
			await withInterpreterStub("foreign-rule", stdoutStub(report), async (interpreter) => {
				const outcome = await runCruise(
					{ timeoutMs: 60_000, maxOutputBytes: 1_000_000 },
					withLauncher(interpreter),
				);
				const incomplete = incompleteOf(outcome);
				expect(incomplete.reason).toContain("carries suspect evidence");
				expect(incomplete.reason).toContain("which the compiled policy does not declare");
				// The coverage loss is named too — the run is honest about both.
				expect(incomplete.reason).toContain("does not assert");
			});
		},
	);

	test.skipIf(!TOOL_AVAILABLE || !IS_POSIX)(
		"a successful empty graph is incomplete with its coverage loss named — never a clean pass",
		async () => {
			const report = JSON.stringify({
				modules: [],
				summary: {
					violations: [],
					error: 0,
					warn: 0,
					info: 0,
					ignore: 0,
					totalCruised: 0,
					totalDependenciesCruised: 0,
				},
			});
			await withInterpreterStub("empty-graph", stdoutStub(report), async (interpreter) => {
				const outcome = await runCruise(
					{ timeoutMs: 60_000, maxOutputBytes: 1_000_000 },
					withLauncher(interpreter),
				);
				const incomplete = incompleteOf(outcome);
				expect(incomplete.reason).toContain("does not assert 12 of 12 staged files");
				expect(incomplete.reason).toContain("successful empty graph");
			});
		},
	);
});
