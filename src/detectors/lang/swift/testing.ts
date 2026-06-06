/**
 * Swift adapter — §5.3 Testing detectors (deterministic subset).
 *
 * `unit_tests_runnable` is the §5.3 gate, and like the TypeScript adapter it must
 * not pass a no-op: we run the package's own `swift test` and require ≥1 test to
 * actually execute (parsed from the `Executed N tests` summary). Both detectors
 * degrade to `no-detector` when the Swift toolchain is unavailable — the honest
 * "configured-but-can't-run" signal that keeps CI (which has no Swift) from
 * silently failing the criterion. `test_coverage_thresholds` demands coverage be
 * configured **and enforced**: `swift test --enable-code-coverage` only emits a
 * profile, so a printed report that gates nothing fails — we require a ratchet
 * script or a threshold check (llvm-cov / xccov / xcov minimum) in the tooling.
 */
import { SPAWN_FAILURE_EXIT } from "../../context.ts";
import { type Detector, fail, noDetector, pass } from "../../types.ts";
import { firstPresent, gatherToolingText, readManifest } from "./util.ts";

/**
 * Best-effort parse of `swift test`'s summary line, e.g.
 * `Executed 12 tests, with 0 failures (0 unexpected) in 0.5 seconds`. Multiple
 * summaries (one per suite) are summed. `executed` is null when none are found.
 */
export function parseSwiftTestCount(output: string): { executed: number | null; failed: number } {
	const re = /Executed\s+(\d+)\s+tests?,\s+with\s+(\d+)\s+failures?/gi;
	let executed: number | null = null;
	let failed = 0;
	for (const m of output.matchAll(re)) {
		executed = (executed ?? 0) + Number(m[1]);
		failed += Number(m[2]);
	}
	return { executed, failed };
}

/** `unit_tests_runnable` (A/L2, GATE): `swift test` runs ≥1 real test, not a no-op. */
export const unitTestsRunnable: Detector = async (ctx) => {
	if ((await readManifest(ctx)) === null) {
		return fail("no Package.swift; `swift test` is not configured");
	}
	const result = await ctx.run(["swift", "test"]);
	if (result.timedOut) return noDetector("`swift test` timed out before completing");
	if (result.exitCode === SPAWN_FAILURE_EXIT) {
		return noDetector(
			"Package.swift present but `swift test` could not run (toolchain unavailable)",
		);
	}
	const { executed, failed } = parseSwiftTestCount(`${result.stdout}\n${result.stderr}`);
	if (executed === null) {
		return result.exitCode === 0
			? noDetector("`swift test` exited 0 but produced no parseable test count")
			: fail(`\`swift test\` failed (exit ${result.exitCode}) with no parseable test count`);
	}
	if (executed === 0) return fail("`swift test` is a no-op: 0 tests executed");
	if (failed > 0 || result.exitCode !== 0) {
		return fail(`${executed} test(s) ran but ${failed || "some"} failed (exit ${result.exitCode})`);
	}
	return pass(`${executed} test(s) executed and passed via \`swift test\``);
};

/** Coverage ratchet script filenames (enforcement, not just a printed profile). */
const RATCHET_SCRIPTS = [
	"scripts/check-coverage.sh",
	"scripts/check-coverage.swift",
	"scripts/coverage.sh",
	"scripts/coverage-ratchet.sh",
] as const;

/** Tools/keywords that gate on a coverage minimum (paired with `--enable-code-coverage`). */
const COVERAGE_THRESHOLD_RE =
	/llvm-cov|xccov|xcov|fail[_-]?under|min(?:imum)?[-_ ]?coverage|threshold/i;
/** SwiftPM's coverage-collection flag. */
const ENABLE_COVERAGE_RE = /--enable-code-coverage|enableCodeCoverage/i;

/** `test_coverage_thresholds` (A/L2): coverage configured AND enforced (ratchet or threshold). */
export const testCoverageThresholds: Detector = async (ctx) => {
	const ratchet = await firstPresent(ctx, RATCHET_SCRIPTS);
	if (ratchet !== null) return pass(`coverage enforced via ratchet script '${ratchet}'`);
	const tooling = await gatherToolingText(ctx);
	const collects = ENABLE_COVERAGE_RE.test(tooling);
	if (collects && COVERAGE_THRESHOLD_RE.test(tooling)) {
		return pass("coverage collected (`--enable-code-coverage`) and gated on a threshold");
	}
	if (collects) {
		return fail("coverage is collected but not enforced (no threshold gate on the profile)");
	}
	return fail("coverage is not configured AND enforced (no ratchet script or threshold gate)");
};
