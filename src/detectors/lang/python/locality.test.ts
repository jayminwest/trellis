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
	mutationTesting,
	orphanModuleDetection,
	strictestTypeChecking,
} from "./locality.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function repo(files: Record<string, string>): Promise<DetectionContext> {
	const root = await mkdtemp(join(tmpdir(), "trellis-python-loc-"));
	dirs.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(root, rel);
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, content);
	}
	return createDetectionContext(root, { path: ".", languages: ["python"] });
}

describe("importCycleDetection", () => {
	test("passes with an import-linter config (.importlinter)", async () => {
		const r = await importCycleDetection(await repo({ ".importlinter": "[importlinter]\n" }));
		expect(r.numerator).toBe(1);
	});

	test("passes with a [tool.importlinter] table", async () => {
		const r = await importCycleDetection(await repo({ "pyproject.toml": "[tool.importlinter]\n" }));
		expect(r.numerator).toBe(1);
	});

	test("passes when pydeps is wired via tooling", async () => {
		const r = await importCycleDetection(await repo({ Makefile: "graph:\n\tpydeps src\n" }));
		expect(r.numerator).toBe(1);
	});

	test("fails (non-skippable gate) with no cycle detector", async () => {
		const r = await importCycleDetection(await repo({ "pyproject.toml": "[project]\n" }));
		expect(r.numerator).toBe(0);
		expect(r.naKind).toBeUndefined();
	});
});

describe("orphanModuleDetection", () => {
	test("passes when pydeps is wired via tooling", async () => {
		const r = await orphanModuleDetection(
			await repo({ Makefile: "orphans:\n\tpydeps --show-cycles src\n" }),
		);
		expect(r.numerator).toBe(1);
	});

	test("passes with a [tool.tach] table", async () => {
		expect(
			(await orphanModuleDetection(await repo({ "pyproject.toml": "[tool.tach]\n" }))).numerator,
		).toBe(1);
	});

	test("fails with no orphan-module analyzer", async () => {
		const r = await orphanModuleDetection(await repo({ "pyproject.toml": "[project]\n" }));
		expect(r.numerator).toBe(0);
		expect(r.naKind).toBeUndefined();
	});
});

describe("cross-language not-applicable (SPEC §8.3)", () => {
	test("explicit_any_detection is not-applicable for Python", async () => {
		const r = await explicitAnyDetection(await repo({}));
		expect(r.numerator).toBeNull();
		expect(r.naKind).toBe("not-applicable");
		expect(r.rationale).toMatch(/no Python analogue/i);
	});

	test("greppable_exports is not-applicable for Python", async () => {
		const r = await greppableExports(await repo({}));
		expect(r.naKind).toBe("not-applicable");
		expect(r.rationale).toMatch(/__all__|export/i);
	});

	test("barrel_file_reexport_detection is not-applicable for Python", async () => {
		const r = await barrelFileReexportDetection(await repo({}));
		expect(r.naKind).toBe("not-applicable");
	});

	test("strictest_type_checking is not-applicable for Python (mypy --strict is the ceiling)", async () => {
		const r = await strictestTypeChecking(await repo({}));
		expect(r.naKind).toBe("not-applicable");
		expect(r.rationale).toMatch(/strict/i);
	});
});

describe("mutationTesting", () => {
	test("passes with a [tool.mutmut] table", async () => {
		expect(
			(await mutationTesting(await repo({ "pyproject.toml": "[tool.mutmut]\n" }))).numerator,
		).toBe(1);
	});

	test("passes with a [mutmut] section in setup.cfg", async () => {
		expect((await mutationTesting(await repo({ "setup.cfg": "[mutmut]\n" }))).numerator).toBe(1);
	});

	test("not-applicable (skippable) when no harness is configured", async () => {
		const r = await mutationTesting(await repo({ "pyproject.toml": "[project]\n" }));
		expect(r.numerator).toBeNull();
		expect(r.naKind).toBe("not-applicable");
	});
});
