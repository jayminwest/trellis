import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDetectionContext } from "../../context.ts";
import type { DetectionContext, ExecResult } from "../../types.ts";
import { parseTestCount, testCoverageThresholds, unitTestsRunnable } from "./testing.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function repo(
	files: Record<string, string>,
	run?: (argv: string[]) => Promise<ExecResult>,
): Promise<DetectionContext> {
	const root = await mkdtemp(join(tmpdir(), "trellis-ts-test-"));
	dirs.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(root, rel);
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, content);
	}
	const ctx = createDetectionContext(root, { path: ".", languages: ["typescript"] });
	return run === undefined ? ctx : { ...ctx, run: (argv) => run(argv) };
}

const exec = (exitCode: number, extra: Partial<ExecResult> = {}): ExecResult => ({
	exitCode,
	stdout: "",
	stderr: "",
	timedOut: false,
	...extra,
});

describe("parseTestCount", () => {
	test("parses Bun output (pass + fail)", () => {
		expect(parseTestCount(" 12 pass\n 1 fail\n")).toEqual({ executed: 13, failed: 1 });
	});

	test("parses Jest output", () => {
		expect(parseTestCount("Tests:       2 failed, 5 passed, 7 total")).toEqual({
			executed: 7,
			failed: 2,
		});
	});

	test("parses Vitest output", () => {
		expect(parseTestCount("Tests  9 passed (9)")).toEqual({ executed: 9, failed: 0 });
	});

	test("returns null when no count is present", () => {
		expect(parseTestCount("nothing here").executed).toBeNull();
	});
});

describe("unitTestsRunnable", () => {
	test("passes when ≥1 test executes and the suite is green", async () => {
		const r = await unitTestsRunnable(
			await repo({ "package.json": '{"scripts":{"test":"bun test"}}' }, async () =>
				exec(0, { stdout: " 3 pass\n 0 fail\n" }),
			),
		);
		expect(r.numerator).toBe(1);
	});

	test("fails an explicit no-op test script without running anything", async () => {
		const r = await unitTestsRunnable(
			await repo({ "package.json": '{"scripts":{"test":"echo no tests"}}' }),
		);
		expect(r.numerator).toBe(0);
		expect(r.naKind).toBeUndefined();
	});

	test("fails when 0 tests execute (silent no-op)", async () => {
		const r = await unitTestsRunnable(
			await repo({ "package.json": '{"scripts":{"test":"bun test"}}' }, async () =>
				exec(0, { stdout: " 0 pass\n 0 fail\n" }),
			),
		);
		expect(r.numerator).toBe(0);
	});

	test("fails when tests run but some fail", async () => {
		const r = await unitTestsRunnable(
			await repo({ "package.json": '{"scripts":{"test":"bun test"}}' }, async () =>
				exec(1, { stdout: " 4 pass\n 2 fail\n" }),
			),
		);
		expect(r.numerator).toBe(0);
	});

	test("no-detector when the runner cannot be spawned", async () => {
		const r = await unitTestsRunnable(
			await repo({ "package.json": '{"scripts":{"test":"bun test"}}' }, async () => exec(127)),
		);
		expect(r.naKind).toBe("no-detector");
	});

	test("no-detector when the runner times out", async () => {
		const r = await unitTestsRunnable(await repo({}, async () => exec(127, { timedOut: true })));
		expect(r.naKind).toBe("no-detector");
	});
});

describe("testCoverageThresholds", () => {
	test("passes with a coverage ratchet script", async () => {
		const r = await testCoverageThresholds(
			await repo({
				"package.json": '{"scripts":{"check:coverage":"bun run scripts/check-coverage.ts"}}',
			}),
		);
		expect(r.numerator).toBe(1);
	});

	test("passes with a bunfig coverage threshold", async () => {
		const r = await testCoverageThresholds(
			await repo({ "bunfig.toml": "[test]\ncoverageThreshold = 0.9\n" }),
		);
		expect(r.numerator).toBe(1);
	});

	test("passes with a Jest coverageThreshold", async () => {
		const r = await testCoverageThresholds(
			await repo({ "package.json": '{"jest":{"coverageThreshold":{"global":{"lines":90}}}}' }),
		);
		expect(r.numerator).toBe(1);
	});

	test("fails (non-skippable) when coverage is reported but not enforced", async () => {
		const r = await testCoverageThresholds(
			await repo({ "package.json": '{"scripts":{"test:coverage":"bun test --coverage"}}' }),
		);
		expect(r.numerator).toBe(0);
		expect(r.naKind).toBeUndefined();
	});
});
