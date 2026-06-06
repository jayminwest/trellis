import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDetectionContext } from "../../context.ts";
import type { DetectionContext, ExecResult } from "../../types.ts";
import { parseSwiftTestCount, testCoverageThresholds, unitTestsRunnable } from "./testing.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function repo(
	files: Record<string, string>,
	run?: (argv: string[]) => Promise<ExecResult>,
): Promise<DetectionContext> {
	const root = await mkdtemp(join(tmpdir(), "trellis-swift-test-"));
	dirs.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(root, rel);
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, content);
	}
	const ctx = createDetectionContext(root, { path: ".", languages: ["swift"] });
	return run === undefined ? ctx : { ...ctx, run: (argv) => run(argv) };
}

const exec = (exitCode: number, extra: Partial<ExecResult> = {}): ExecResult => ({
	exitCode,
	stdout: "",
	stderr: "",
	timedOut: false,
	...extra,
});

describe("parseSwiftTestCount", () => {
	test("parses a single summary line", () => {
		expect(
			parseSwiftTestCount("Executed 12 tests, with 0 failures (0 unexpected) in 0.5s"),
		).toEqual({ executed: 12, failed: 0 });
	});

	test("sums multiple per-suite summaries and counts failures", () => {
		const out =
			"Executed 3 tests, with 1 failure in 0.1s\nExecuted 5 tests, with 0 failures in 0.2s";
		expect(parseSwiftTestCount(out)).toEqual({ executed: 8, failed: 1 });
	});

	test("returns null when no summary is present", () => {
		expect(parseSwiftTestCount("error: no such module")).toEqual({ executed: null, failed: 0 });
	});
});

describe("unitTestsRunnable", () => {
	test("passes when swift test executes ≥1 test cleanly", async () => {
		const r = await unitTestsRunnable(
			await repo({ "Package.swift": "// swift\n" }, async () =>
				exec(0, { stdout: "Executed 4 tests, with 0 failures (0 unexpected) in 0.1s" }),
			),
		);
		expect(r.numerator).toBe(1);
	});

	test("invokes `swift test`", async () => {
		let argv: string[] = [];
		await unitTestsRunnable(
			await repo({ "Package.swift": "// swift\n" }, async (a) => {
				argv = a;
				return exec(0, { stdout: "Executed 1 tests, with 0 failures in 0.1s" });
			}),
		);
		expect(argv).toEqual(["swift", "test"]);
	});

	test("fails on a no-op suite (0 tests executed)", async () => {
		const r = await unitTestsRunnable(
			await repo({ "Package.swift": "// swift\n" }, async () =>
				exec(0, { stdout: "Executed 0 tests, with 0 failures in 0.0s" }),
			),
		);
		expect(r.numerator).toBe(0);
		expect(r.naKind).toBeUndefined();
	});

	test("fails when some tests fail", async () => {
		const r = await unitTestsRunnable(
			await repo({ "Package.swift": "// swift\n" }, async () =>
				exec(1, { stdout: "Executed 4 tests, with 2 failures in 0.1s" }),
			),
		);
		expect(r.numerator).toBe(0);
	});

	test("no-detector when the toolchain is unavailable", async () => {
		const r = await unitTestsRunnable(
			await repo({ "Package.swift": "// swift\n" }, async () => exec(127)),
		);
		expect(r.naKind).toBe("no-detector");
	});

	test("no-detector when exit 0 but no parseable count", async () => {
		const r = await unitTestsRunnable(
			await repo({ "Package.swift": "// swift\n" }, async () => exec(0, { stdout: "Building..." })),
		);
		expect(r.naKind).toBe("no-detector");
	});

	test("fails when there is no Package.swift", async () => {
		expect((await unitTestsRunnable(await repo({}))).numerator).toBe(0);
	});
});

describe("testCoverageThresholds", () => {
	test("passes with a coverage ratchet script", async () => {
		const r = await testCoverageThresholds(
			await repo({ "scripts/check-coverage.sh": "#!/bin/sh\nexit 0\n" }),
		);
		expect(r.numerator).toBe(1);
	});

	test("passes when coverage is collected and gated on a threshold in CI", async () => {
		const r = await testCoverageThresholds(
			await repo({
				".github/workflows/ci.yml":
					"jobs:\n  test:\n    steps:\n      - run: swift test --enable-code-coverage\n      - run: llvm-cov report --fail-under 80\n",
			}),
		);
		expect(r.numerator).toBe(1);
	});

	test("fails when coverage is collected but not enforced", async () => {
		const r = await testCoverageThresholds(
			await repo({
				".github/workflows/ci.yml":
					"jobs:\n  test:\n    steps:\n      - run: swift test --enable-code-coverage\n",
			}),
		);
		expect(r.numerator).toBe(0);
		expect(r.rationale).toMatch(/not enforced/i);
	});

	test("fails when coverage is not configured at all", async () => {
		expect(
			(await testCoverageThresholds(await repo({ "Package.swift": "// swift\n" }))).numerator,
		).toBe(0);
	});
});
