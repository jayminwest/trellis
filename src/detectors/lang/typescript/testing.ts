/**
 * TypeScript adapter — §5.3 Testing detectors (deterministic subset).
 *
 * `unit_tests_runnable` is the §5.3 gate, and the SPEC is emphatic that it must
 * not pass a no-op: we run the repo's own test command and require ≥1 test to
 * actually execute. `test_coverage_thresholds` demands coverage be configured
 * **and enforced** — a printed coverage report that gates nothing doesn't count;
 * we look for a ratchet script or a real threshold in the runner config.
 */

import { packageScripts, readJson } from "../../common/util.ts";
import { SPAWN_FAILURE_EXIT } from "../../context.ts";
import { type Detector, fail, noDetector, pass } from "../../types.ts";
import { readJsonc, scriptMatches } from "./util.ts";

/**
 * Best-effort parse of an executed/failed test count from a runner's output.
 * Recognizes Bun (`N pass` / `N fail`), Jest/Vitest (`Tests: N passed`), and a
 * generic `Ran N tests`. `executed` is null when no count could be found.
 */
export function parseTestCount(output: string): { executed: number | null; failed: number } {
	const bunPass = output.match(/(\d+)\s+pass\b/);
	const bunFail = output.match(/(\d+)\s+fail\b/);
	if (bunPass !== null) {
		const passed = Number(bunPass[1]);
		const failed = bunFail !== null ? Number(bunFail[1]) : 0;
		return { executed: passed + failed, failed };
	}
	const jestVitest = output.match(/Tests?[:\s]+(?:(\d+)\s+failed[,\s]+)?(\d+)\s+passed/i);
	if (jestVitest !== null) {
		const failed = jestVitest[1] !== undefined ? Number(jestVitest[1]) : 0;
		const passed = Number(jestVitest[2]);
		return { executed: passed + failed, failed };
	}
	const generic = output.match(/Ran\s+(\d+)\s+tests?/i);
	if (generic !== null) return { executed: Number(generic[1]), failed: 0 };
	return { executed: null, failed: 0 };
}

/** `unit_tests_runnable` (A/L2, GATE): the test command runs ≥1 real test, not a no-op. */
export const unitTestsRunnable: Detector = async (ctx) => {
	const scripts = packageScripts(await readJson(ctx, "package.json"));
	const testScript = scripts.test;
	const argv = testScript !== undefined ? ["bun", "run", "test"] : ["bun", "test"];
	if (testScript !== undefined && /^(echo|exit|true|:)\b/.test(testScript.trim())) {
		return fail(`\`test\` script is a no-op placeholder: '${testScript}'`);
	}
	const result = await ctx.run(argv);
	if (result.timedOut) return noDetector("test command timed out before completing");
	if (result.exitCode === SPAWN_FAILURE_EXIT) {
		return noDetector("test runner could not be executed (tool unavailable)");
	}
	const { executed, failed } = parseTestCount(`${result.stdout}\n${result.stderr}`);
	if (executed === null) {
		return result.exitCode === 0
			? noDetector("test command exited 0 but produced no parseable test count")
			: fail(`test command failed (exit ${result.exitCode}) with no parseable test count`);
	}
	if (executed === 0) return fail("test command is a no-op: 0 tests executed");
	if (failed > 0 || result.exitCode !== 0) {
		return fail(`${executed} test(s) ran but ${failed || "some"} failed (exit ${result.exitCode})`);
	}
	return pass(`${executed} test(s) executed and passed`);
};

/** Runner config files that can carry a coverage threshold. */
const RUNNER_CONFIGS = [
	"vitest.config.ts",
	"vitest.config.js",
	"vitest.config.mts",
	"vite.config.ts",
	"vite.config.js",
	"jest.config.ts",
	"jest.config.js",
	"jest.config.cjs",
	"jest.config.mjs",
] as const;

/** A coverage ratchet script (the os-eco convention): enforcement, not just a printed report. */
async function coverageRatchet(
	ctx: import("../../types.ts").DetectionContext,
	scripts: Record<string, string>,
): Promise<string | null> {
	if (scriptMatches(scripts, /check.?coverage|coverage.?(ratchet|gate|check)/i)) {
		return "coverage enforced via a ratchet/check script";
	}
	for (const rel of [
		"scripts/check-coverage.ts",
		"scripts/check-coverage.js",
		"scripts/coverage-ratchet.ts",
	]) {
		if ((await ctx.readFile(rel)) !== null) return `coverage ratchet script present: '${rel}'`;
	}
	return null;
}

/** A real coverage threshold in a runner config (bunfig / Jest / Vitest / nyc). */
async function coverageThresholdConfig(
	ctx: import("../../types.ts").DetectionContext,
	pkg: Record<string, unknown> | null,
): Promise<string | null> {
	const bunfig = await ctx.readFile("bunfig.toml");
	if (bunfig !== null && /coverageThreshold/.test(bunfig)) {
		return "Bun coverage threshold configured in bunfig.toml";
	}
	const jestCfg = pkg?.jest;
	if (typeof jestCfg === "object" && jestCfg !== null && "coverageThreshold" in jestCfg) {
		return "Jest `coverageThreshold` configured in package.json";
	}
	for (const rel of RUNNER_CONFIGS) {
		const text = await ctx.readFile(rel);
		if (text !== null && THRESHOLD_RE.test(text))
			return `coverage threshold configured in '${rel}'`;
	}
	const nyc = (await readJsonc(ctx, ".nycrc")) ?? (await readJsonc(ctx, ".nycrc.json"));
	const nycHasThreshold =
		nyc !== null && (nyc["check-coverage"] === true || "lines" in nyc || "branches" in nyc);
	if (nycHasThreshold || (typeof pkg?.nyc === "object" && pkg.nyc !== null)) {
		return "nyc/c8 coverage threshold configured";
	}
	return null;
}

/** Match a threshold in a runner config file's text. */
const THRESHOLD_RE = /coverageThreshold|thresholds\s*:|lines\s*:\s*\d|statements\s*:\s*\d/;

/** `test_coverage_thresholds` (A/L2): coverage configured AND enforced (ratchet or threshold). */
export const testCoverageThresholds: Detector = async (ctx) => {
	const pkg = await readJson(ctx, "package.json");
	const ratchet = await coverageRatchet(ctx, packageScripts(pkg));
	if (ratchet !== null) return pass(ratchet);
	const threshold = await coverageThresholdConfig(ctx, pkg);
	if (threshold !== null) return pass(threshold);
	return fail("coverage is not configured AND enforced (no ratchet script or threshold config)");
};
