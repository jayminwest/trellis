/**
 * Python adapter — §5.3 Testing detectors (deterministic subset).
 *
 * `unit_tests_runnable` is the §5.3 gate, and like the other adapters it must not
 * pass a no-op: we run `pytest` and require ≥1 test to actually execute (parsed
 * from pytest's summary line). It degrades to `no-detector` when the toolchain is
 * unavailable — the honest "configured-but-can't-run" signal that keeps CI (which
 * has no Python) from silently failing the criterion. `test_coverage_thresholds`
 * demands coverage be configured **and enforced**: coverage.py emitting a report
 * gates nothing, so we require a real threshold (`fail_under` / `--cov-fail-under`)
 * or a ratchet script — config-first, no run needed.
 */
import { SPAWN_FAILURE_EXIT } from "../../context.ts";
import { type Detector, fail, noDetector, pass } from "../../types.ts";
import { firstPresent, gatherToolingText, toolingMentions } from "./util.ts";

/**
 * Best-effort parse of pytest's summary line, e.g. `===== 1 failed, 4 passed in
 * 0.1s =====` or `===== 3 passed =====`. `passed`/`failed`/`error` counts are
 * summed into the executed total. `executed` is 0 for an explicit empty run
 * (`no tests ran` / `collected 0 items`) and `null` when nothing is parseable.
 */
export function parsePytestCount(output: string): { executed: number | null; failed: number } {
	const passed = output.match(/(\d+)\s+passed/);
	const failed = output.match(/(\d+)\s+failed/);
	const errors = output.match(/(\d+)\s+errors?/);
	if (passed === null && failed === null && errors === null) {
		return /no tests ran|collected 0 items/i.test(output)
			? { executed: 0, failed: 0 }
			: { executed: null, failed: 0 };
	}
	const passedN = passed !== null ? Number(passed[1]) : 0;
	const failedN =
		(failed !== null ? Number(failed[1]) : 0) + (errors !== null ? Number(errors[1]) : 0);
	return { executed: passedN + failedN, failed: failedN };
}

/** `unit_tests_runnable` (A/L2, GATE): `pytest` runs ≥1 real test, not a no-op. */
export const unitTestsRunnable: Detector = async (ctx) => {
	const result = await ctx.run(["pytest"]);
	if (result.timedOut) return noDetector("`pytest` timed out before completing");
	if (result.exitCode === SPAWN_FAILURE_EXIT) {
		return noDetector("`pytest` could not be executed (toolchain unavailable)");
	}
	const { executed, failed } = parsePytestCount(`${result.stdout}\n${result.stderr}`);
	if (executed === null) {
		return result.exitCode === 0
			? noDetector("`pytest` exited 0 but produced no parseable test count")
			: fail(`\`pytest\` failed (exit ${result.exitCode}) with no parseable test count`);
	}
	if (executed === 0) return fail("`pytest` is a no-op: 0 tests executed");
	if (failed > 0 || result.exitCode !== 0) {
		return fail(`${executed} test(s) ran but ${failed || "some"} failed (exit ${result.exitCode})`);
	}
	return pass(`${executed} test(s) executed and passed via \`pytest\``);
};

/** Coverage ratchet script filenames (enforcement, not just a printed report). */
const RATCHET_SCRIPTS = [
	"scripts/check-coverage.sh",
	"scripts/check-coverage.py",
	"scripts/coverage.sh",
	"scripts/coverage-ratchet.sh",
	"scripts/coverage-ratchet.py",
] as const;

/** Config files that can carry a coverage.py / pytest-cov threshold. */
const THRESHOLD_CONFIGS = [
	"pyproject.toml",
	".coveragerc",
	"setup.cfg",
	"tox.ini",
	"pytest.ini",
] as const;

/** A coverage minimum that actually gates the build (coverage.py `fail_under` / pytest-cov). */
const THRESHOLD_RE = /fail_under|--cov-fail-under|fail-under/i;

/** `test_coverage_thresholds` (A/L2): coverage configured AND enforced (ratchet or threshold). */
export const testCoverageThresholds: Detector = async (ctx) => {
	const ratchet = await firstPresent(ctx, RATCHET_SCRIPTS);
	if (ratchet !== null) return pass(`coverage enforced via ratchet script '${ratchet}'`);
	for (const rel of THRESHOLD_CONFIGS) {
		const text = await ctx.readFile(rel);
		if (text !== null && THRESHOLD_RE.test(text)) {
			return pass(`coverage threshold enforced in '${rel}'`);
		}
	}
	if (toolingMentions(await gatherToolingText(ctx), /--cov-fail-under/i)) {
		return pass("coverage threshold enforced via build tooling (`--cov-fail-under`)");
	}
	return fail(
		"coverage is not configured AND enforced (no `fail_under` / `--cov-fail-under` / ratchet)",
	);
};
