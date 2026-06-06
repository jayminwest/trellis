import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDetectionContext } from "../../context.ts";
import type { DetectionContext, ExecResult } from "../../types.ts";
import { parsePytestCount, testCoverageThresholds, unitTestsRunnable } from "./testing.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function repo(
	files: Record<string, string>,
	run?: (argv: string[]) => Promise<ExecResult>,
): Promise<DetectionContext> {
	const root = await mkdtemp(join(tmpdir(), "trellis-python-test-"));
	dirs.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(root, rel);
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, content);
	}
	const ctx = createDetectionContext(root, { path: ".", languages: ["python"] });
	return run === undefined ? ctx : { ...ctx, run: (argv) => run(argv) };
}

const exec = (extra: Partial<ExecResult> = {}): ExecResult => ({
	exitCode: 0,
	stdout: "",
	stderr: "",
	timedOut: false,
	...extra,
});

describe("parsePytestCount", () => {
	test("parses a passing summary", () => {
		expect(parsePytestCount("===== 5 passed in 0.12s =====")).toEqual({ executed: 5, failed: 0 });
	});

	test("parses a mixed pass/fail summary", () => {
		expect(parsePytestCount("===== 1 failed, 4 passed in 0.3s =====")).toEqual({
			executed: 5,
			failed: 1,
		});
	});

	test("counts errors as failed", () => {
		expect(parsePytestCount("2 passed, 1 error in 0.1s")).toEqual({ executed: 3, failed: 1 });
	});

	test("reports 0 executed for an explicit empty run", () => {
		expect(parsePytestCount("no tests ran in 0.01s")).toEqual({ executed: 0, failed: 0 });
		expect(parsePytestCount("collected 0 items")).toEqual({ executed: 0, failed: 0 });
	});

	test("reports null when nothing is parseable", () => {
		expect(parsePytestCount("some unrelated output")).toEqual({ executed: null, failed: 0 });
	});
});

describe("unitTestsRunnable", () => {
	test("invokes `pytest`", async () => {
		let argv: string[] = [];
		await unitTestsRunnable(
			await repo({}, async (a) => {
				argv = a;
				return exec({ stdout: "3 passed in 0.1s" });
			}),
		);
		expect(argv).toEqual(["pytest"]);
	});

	test("passes when ≥1 test executes and all pass", async () => {
		const r = await unitTestsRunnable(
			await repo({}, async () => exec({ stdout: "===== 3 passed in 0.1s =====" })),
		);
		expect(r.numerator).toBe(1);
	});

	test("fails as a no-op when 0 tests run", async () => {
		const r = await unitTestsRunnable(
			await repo({}, async () => exec({ exitCode: 5, stdout: "no tests ran in 0.01s" })),
		);
		expect(r.numerator).toBe(0);
		expect(r.naKind).toBeUndefined();
	});

	test("fails when tests fail", async () => {
		const r = await unitTestsRunnable(
			await repo({}, async () => exec({ exitCode: 1, stdout: "1 failed, 2 passed in 0.1s" })),
		);
		expect(r.numerator).toBe(0);
	});

	test("no-detector when pytest is unavailable", async () => {
		const r = await unitTestsRunnable(await repo({}, async () => exec({ exitCode: 127 })));
		expect(r.naKind).toBe("no-detector");
	});

	test("no-detector when pytest times out", async () => {
		const r = await unitTestsRunnable(await repo({}, async () => exec({ timedOut: true })));
		expect(r.naKind).toBe("no-detector");
	});

	test("no-detector when exit 0 but no parseable count", async () => {
		const r = await unitTestsRunnable(await repo({}, async () => exec({ stdout: "garbage" })));
		expect(r.naKind).toBe("no-detector");
	});
});

describe("testCoverageThresholds", () => {
	test("passes with coverage.py fail_under in pyproject", async () => {
		const r = await testCoverageThresholds(
			await repo({ "pyproject.toml": "[tool.coverage.report]\nfail_under = 90\n" }),
		);
		expect(r.numerator).toBe(1);
	});

	test("passes with --cov-fail-under in pytest config", async () => {
		const r = await testCoverageThresholds(
			await repo({ "pytest.ini": "[pytest]\naddopts = --cov-fail-under=85\n" }),
		);
		expect(r.numerator).toBe(1);
	});

	test("passes with a coverage ratchet script", async () => {
		const r = await testCoverageThresholds(
			await repo({ "scripts/check-coverage.py": "import sys\n" }),
		);
		expect(r.numerator).toBe(1);
	});

	test("passes when --cov-fail-under is wired via tooling", async () => {
		const r = await testCoverageThresholds(
			await repo({ Makefile: "test:\n\tpytest --cov-fail-under=80\n" }),
		);
		expect(r.numerator).toBe(1);
	});

	test("fails when coverage is collected but not enforced", async () => {
		const r = await testCoverageThresholds(
			await repo({ "pyproject.toml": "[tool.coverage.run]\n" }),
		);
		expect(r.numerator).toBe(0);
		expect(r.naKind).toBeUndefined();
	});
});
