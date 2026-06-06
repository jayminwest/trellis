import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDetectionContext } from "../../context.ts";
import type { DetectionContext, ExecResult } from "../../types.ts";
import {
	codeModularization,
	cyclomaticComplexity,
	deadCodeDetection,
	duplicateCodeDetection,
	formatter,
	lintConfig,
	namingConsistency,
	strictTyping,
	typeCheck,
	unusedDependenciesDetection,
} from "./code-quality.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function repo(
	files: Record<string, string>,
	run?: (argv: string[]) => Promise<ExecResult>,
): Promise<DetectionContext> {
	const root = await mkdtemp(join(tmpdir(), "trellis-ts-cq-"));
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

describe("lintConfig", () => {
	test("passes with a Biome config that enables the linter", async () => {
		const r = await lintConfig(await repo({ "biome.json": '{"linter":{"enabled":true}}' }));
		expect(r.numerator).toBe(1);
	});

	test("passes with an ESLint flat config", async () => {
		expect(
			(await lintConfig(await repo({ "eslint.config.js": "export default []" }))).numerator,
		).toBe(1);
	});

	test("fails (non-skippable) with no linter at all", async () => {
		const r = await lintConfig(await repo({ "package.json": "{}" }));
		expect(r.numerator).toBe(0);
		expect(r.naKind).toBeUndefined();
	});
});

describe("typeCheck", () => {
	test("passes when tsconfig present and tsc runs clean", async () => {
		const r = await typeCheck(
			await repo({ "tsconfig.json": '{"compilerOptions":{}}' }, async () => exec(0)),
		);
		expect(r.numerator).toBe(1);
	});

	test("prefers the repo's own typecheck script", async () => {
		let argv: string[] = [];
		const r = await typeCheck(
			await repo(
				{
					"tsconfig.json": "{}",
					"package.json": '{"scripts":{"typecheck":"tsc --noEmit"}}',
				},
				async (a) => {
					argv = a;
					return exec(0);
				},
			),
		);
		expect(r.numerator).toBe(1);
		expect(argv).toEqual(["bun", "run", "typecheck"]);
	});

	test("fails when the type-checker reports errors", async () => {
		const r = await typeCheck(await repo({ "tsconfig.json": "{}" }, async () => exec(2)));
		expect(r.numerator).toBe(0);
		expect(r.naKind).toBeUndefined();
	});

	test("no-detector when tsc cannot be spawned (configured but unavailable)", async () => {
		const r = await typeCheck(await repo({ "tsconfig.json": "{}" }, async () => exec(127)));
		expect(r.naKind).toBe("no-detector");
	});

	test("fails when there is no tsconfig.json", async () => {
		expect((await typeCheck(await repo({}))).numerator).toBe(0);
	});
});

describe("formatter", () => {
	test("passes with Biome formatter enabled", async () => {
		expect((await formatter(await repo({ "biome.json": "{}" }))).numerator).toBe(1);
	});

	test("passes with a Prettier config file", async () => {
		expect((await formatter(await repo({ ".prettierrc": "{}" }))).numerator).toBe(1);
	});

	test("fails with no formatter", async () => {
		expect((await formatter(await repo({ "package.json": "{}" }))).numerator).toBe(0);
	});
});

describe("strictTyping", () => {
	test("passes when tsconfig sets strict", async () => {
		expect(
			(await strictTyping(await repo({ "tsconfig.json": '{"compilerOptions":{"strict":true}}' })))
				.numerator,
		).toBe(1);
	});

	test("resolves strict through an extends chain", async () => {
		const r = await strictTyping(
			await repo({
				"tsconfig.json": '{"extends":"./base.json"}',
				"base.json": '{"compilerOptions":{"strict":true}}',
			}),
		);
		expect(r.numerator).toBe(1);
	});

	test("fails when tsconfig is not strict", async () => {
		expect(
			(await strictTyping(await repo({ "tsconfig.json": '{"compilerOptions":{}}' }))).numerator,
		).toBe(0);
	});

	test("no-detector when strictness may come from an unresolved preset", async () => {
		const r = await strictTyping(
			await repo({ "tsconfig.json": '{"extends":"@tsconfig/strictest/tsconfig.json"}' }),
		);
		expect(r.naKind).toBe("no-detector");
	});
});

describe("namingConsistency", () => {
	test("passes with Biome useFilenamingConvention", async () => {
		const r = await namingConsistency(
			await repo({
				"biome.json":
					'{"linter":{"enabled":true,"rules":{"style":{"useFilenamingConvention":"error"}}}}',
			}),
		);
		expect(r.numerator).toBe(1);
	});

	test("passes via Biome recommended (useNamingConvention)", async () => {
		const r = await namingConsistency(
			await repo({ "biome.json": '{"linter":{"enabled":true,"rules":{"recommended":true}}}' }),
		);
		expect(r.numerator).toBe(1);
	});

	test("fails with no naming enforcement", async () => {
		expect((await namingConsistency(await repo({ "package.json": "{}" }))).numerator).toBe(0);
	});
});

describe("deadCodeDetection", () => {
	test("passes with knip in devDependencies", async () => {
		expect(
			(await deadCodeDetection(await repo({ "package.json": '{"devDependencies":{"knip":"^6"}}' })))
				.numerator,
		).toBe(1);
	});

	test("passes with a knip config file", async () => {
		expect((await deadCodeDetection(await repo({ "knip.json": "{}" }))).numerator).toBe(1);
	});

	test("fails with no dead-code analyzer", async () => {
		expect((await deadCodeDetection(await repo({ "package.json": "{}" }))).numerator).toBe(0);
	});
});

describe("duplicateCodeDetection", () => {
	test("passes with a jscpd script", async () => {
		expect(
			(
				await duplicateCodeDetection(
					await repo({ "package.json": '{"scripts":{"check:dups":"bunx jscpd"}}' }),
				)
			).numerator,
		).toBe(1);
	});

	test("fails with no duplicate detector", async () => {
		expect((await duplicateCodeDetection(await repo({ "package.json": "{}" }))).numerator).toBe(0);
	});
});

describe("unusedDependenciesDetection", () => {
	test("passes with depcheck", async () => {
		expect(
			(
				await unusedDependenciesDetection(
					await repo({ "package.json": '{"devDependencies":{"depcheck":"^1"}}' }),
				)
			).numerator,
		).toBe(1);
	});

	test("fails with no analyzer", async () => {
		expect(
			(await unusedDependenciesDetection(await repo({ "package.json": "{}" }))).numerator,
		).toBe(0);
	});
});

describe("codeModularization", () => {
	test("passes with dependency-cruiser", async () => {
		expect(
			(
				await codeModularization(
					await repo({ "package.json": '{"devDependencies":{"dependency-cruiser":"^16"}}' }),
				)
			).numerator,
		).toBe(1);
	});

	test("not-applicable (skippable) when no import-direction tool is configured", async () => {
		const r = await codeModularization(await repo({ "package.json": "{}" }));
		expect(r.numerator).toBeNull();
		expect(r.naKind).toBe("not-applicable");
	});
});

describe("cyclomaticComplexity", () => {
	test("passes with Biome cognitive-complexity rule", async () => {
		const r = await cyclomaticComplexity(
			await repo({
				"biome.json":
					'{"linter":{"enabled":true,"rules":{"complexity":{"noExcessiveCognitiveComplexity":{"level":"error","options":{"maxAllowedComplexity":15}}}}}}',
			}),
		);
		expect(r.numerator).toBe(1);
	});

	test("fails (non-skippable) when complexity is not capped", async () => {
		expect(
			(await cyclomaticComplexity(await repo({ "biome.json": '{"linter":{"enabled":true}}' })))
				.numerator,
		).toBe(0);
	});
});
