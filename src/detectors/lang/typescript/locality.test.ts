import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDetectionContext } from "../../context.ts";
import type { DetectionContext } from "../../types.ts";
import {
	barrelFileReexportDetection,
	explicitAnyDetection,
	greppableExports,
	importCycleDetection,
	machineCheckedArchitecture,
	mutationTesting,
	orphanModuleDetection,
	strictestTypeChecking,
} from "./locality.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function repo(files: Record<string, string>): Promise<DetectionContext> {
	const root = await mkdtemp(join(tmpdir(), "trellis-ts-loc-"));
	dirs.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(root, rel);
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, content);
	}
	return createDetectionContext(root, { path: ".", languages: ["typescript"] });
}

describe("machineCheckedArchitecture", () => {
	test("passes with dependency-cruiser", async () => {
		expect(
			(
				await machineCheckedArchitecture(
					await repo({ "package.json": '{"devDependencies":{"dependency-cruiser":"^16"}}' }),
				)
			).numerator,
		).toBe(1);
	});

	test("passes with an *.arch.test.ts suite", async () => {
		expect(
			(
				await machineCheckedArchitecture(
					await repo({ "src/layers.arch.test.ts": "test('x',()=>{})" }),
				)
			).numerator,
		).toBe(1);
	});

	test("not-applicable (skippable) with no arch enforcement", async () => {
		expect((await machineCheckedArchitecture(await repo({ "package.json": "{}" }))).naKind).toBe(
			"not-applicable",
		);
	});
});

describe("importCycleDetection", () => {
	test("passes for an acyclic source tree", async () => {
		const r = await importCycleDetection(
			await repo({ "src/a.ts": 'import { b } from "./b.ts";', "src/b.ts": "export const b = 1;" }),
		);
		expect(r.numerator).toBe(1);
	});

	test("fails (non-skippable) when a cycle exists", async () => {
		const r = await importCycleDetection(
			await repo({ "src/a.ts": 'import "./b.ts";', "src/b.ts": 'import "./a.ts";' }),
		);
		expect(r.numerator).toBe(0);
		expect(r.naKind).toBeUndefined();
	});

	test("no-detector when there are no TypeScript sources", async () => {
		expect((await importCycleDetection(await repo({ "README.md": "x" }))).naKind).toBe(
			"no-detector",
		);
	});
});

describe("orphanModuleDetection", () => {
	test("passes with knip configured", async () => {
		expect(
			(
				await orphanModuleDetection(
					await repo({ "package.json": '{"devDependencies":{"knip":"^6"}}' }),
				)
			).numerator,
		).toBe(1);
	});

	test("fails (non-skippable) with no orphan analyzer", async () => {
		expect((await orphanModuleDetection(await repo({ "package.json": "{}" }))).numerator).toBe(0);
	});
});

describe("explicitAnyDetection", () => {
	test("passes when Biome noExplicitAny is an error", async () => {
		const r = await explicitAnyDetection(
			await repo({
				"biome.json":
					'{"linter":{"enabled":true,"rules":{"suspicious":{"noExplicitAny":"error"}}}}',
			}),
		);
		expect(r.numerator).toBe(1);
	});

	test("fails when noExplicitAny is only a warning", async () => {
		const r = await explicitAnyDetection(
			await repo({
				"biome.json": '{"linter":{"enabled":true,"rules":{"suspicious":{"noExplicitAny":"warn"}}}}',
			}),
		);
		expect(r.numerator).toBe(0);
	});

	test("passes via ESLint no-explicit-any as error", async () => {
		const r = await explicitAnyDetection(
			await repo({
				"eslint.config.js":
					'export default [{rules:{"@typescript-eslint/no-explicit-any":"error"}}]',
			}),
		);
		expect(r.numerator).toBe(1);
	});

	test("fails when `any` is not enforced at all", async () => {
		expect((await explicitAnyDetection(await repo({ "package.json": "{}" }))).numerator).toBe(0);
	});
});

describe("strictestTypeChecking", () => {
	test("passes with strict + noUncheckedIndexedAccess", async () => {
		const r = await strictestTypeChecking(
			await repo({
				"tsconfig.json": '{"compilerOptions":{"strict":true,"noUncheckedIndexedAccess":true}}',
			}),
		);
		expect(r.numerator).toBe(1);
	});

	test("fails with only baseline strict", async () => {
		expect(
			(
				await strictestTypeChecking(
					await repo({ "tsconfig.json": '{"compilerOptions":{"strict":true}}' }),
				)
			).numerator,
		).toBe(0);
	});

	test("fails with no tsconfig", async () => {
		expect((await strictestTypeChecking(await repo({}))).numerator).toBe(0);
	});
});

describe("greppableExports", () => {
	test("passes when there are no default exports", async () => {
		expect(
			(await greppableExports(await repo({ "src/a.ts": "export const a = 1;" }))).numerator,
		).toBe(1);
	});

	test("fails when a default export exists", async () => {
		const r = await greppableExports(await repo({ "src/a.ts": "export default function () {}" }));
		expect(r.numerator).toBe(0);
		expect(r.naKind).toBeUndefined();
	});

	test("fails on an `export { x as default }` form", async () => {
		const r = await greppableExports(
			await repo({ "src/a.ts": "const x = 1;\nexport { x as default };" }),
		);
		expect(r.numerator).toBe(0);
	});

	test("not-applicable when there are no TypeScript sources", async () => {
		expect((await greppableExports(await repo({ "README.md": "x" }))).naKind).toBe(
			"not-applicable",
		);
	});
});

describe("barrelFileReexportDetection", () => {
	test("passes with no wildcard re-exports", async () => {
		expect(
			(await barrelFileReexportDetection(await repo({ "src/a.ts": 'export { b } from "./b.ts";' })))
				.numerator,
		).toBe(1);
	});

	test("fails on an `export *` barrel", async () => {
		const r = await barrelFileReexportDetection(
			await repo({ "src/index.ts": 'export * from "./a.ts";' }),
		);
		expect(r.numerator).toBe(0);
	});

	test("not-applicable with no sources", async () => {
		expect((await barrelFileReexportDetection(await repo({ "README.md": "x" }))).naKind).toBe(
			"not-applicable",
		);
	});
});

describe("mutationTesting", () => {
	test("passes with a StrykerJS dependency", async () => {
		expect(
			(
				await mutationTesting(
					await repo({ "package.json": '{"devDependencies":{"@stryker-mutator/core":"^8"}}' }),
				)
			).numerator,
		).toBe(1);
	});

	test("not-applicable (skippable) with no mutation harness", async () => {
		expect((await mutationTesting(await repo({ "package.json": "{}" }))).naKind).toBe(
			"not-applicable",
		);
	});
});
