import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDetectionContext } from "../../context.ts";
import type { DetectionContext, ExecResult } from "../../types.ts";
import {
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

/** Build a Python fixture tree and a detection context over it. */
async function repo(
	files: Record<string, string>,
	run?: (argv: string[]) => Promise<ExecResult>,
): Promise<DetectionContext> {
	const root = await mkdtemp(join(tmpdir(), "trellis-python-cq-"));
	dirs.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(root, rel);
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, content);
	}
	const ctx = createDetectionContext(root, { path: ".", languages: ["python"] });
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
	test("passes with a [tool.ruff] table in pyproject.toml", async () => {
		const r = await lintConfig(
			await repo({ "pyproject.toml": "[tool.ruff]\nline-length = 100\n" }),
		);
		expect(r.numerator).toBe(1);
	});

	test("passes with a .flake8 dotfile", async () => {
		expect((await lintConfig(await repo({ ".flake8": "[flake8]\n" }))).numerator).toBe(1);
	});

	test("passes when ruff is wired via a Makefile", async () => {
		const r = await lintConfig(await repo({ Makefile: "lint:\n\truff check .\n" }));
		expect(r.numerator).toBe(1);
	});

	test("fails (non-skippable) with no linter at all", async () => {
		const r = await lintConfig(await repo({ "pyproject.toml": "[project]\nname = 'x'\n" }));
		expect(r.numerator).toBe(0);
		expect(r.naKind).toBeUndefined();
	});
});

describe("typeCheck", () => {
	test("passes when mypy configured and runs clean", async () => {
		const r = await typeCheck(
			await repo({ "pyproject.toml": "[tool.mypy]\n" }, async () => exec(0)),
		);
		expect(r.numerator).toBe(1);
	});

	test("invokes `mypy .`", async () => {
		let argv: string[] = [];
		await typeCheck(
			await repo({ "mypy.ini": "[mypy]\n" }, async (a) => {
				argv = a;
				return exec(0);
			}),
		);
		expect(argv).toEqual(["mypy", "."]);
	});

	test("fails when mypy reports type errors", async () => {
		const r = await typeCheck(await repo({ "mypy.ini": "[mypy]\n" }, async () => exec(1)));
		expect(r.numerator).toBe(0);
		expect(r.naKind).toBeUndefined();
	});

	test("no-detector when the toolchain is unavailable (configured but can't run)", async () => {
		const r = await typeCheck(await repo({ "mypy.ini": "[mypy]\n" }, async () => exec(127)));
		expect(r.naKind).toBe("no-detector");
	});

	test("no-detector when mypy times out", async () => {
		const r = await typeCheck(
			await repo({ "mypy.ini": "[mypy]\n" }, async () => exec(0, { timedOut: true })),
		);
		expect(r.naKind).toBe("no-detector");
	});

	test("fails when no type checker is configured", async () => {
		expect((await typeCheck(await repo({ "pyproject.toml": "[project]\n" }))).numerator).toBe(0);
	});
});

describe("strictTyping", () => {
	test("passes with mypy strict = true in pyproject", async () => {
		const r = await strictTyping(await repo({ "pyproject.toml": "[tool.mypy]\nstrict = true\n" }));
		expect(r.numerator).toBe(1);
	});

	test("passes when mypy --strict is invoked in tooling", async () => {
		const r = await strictTyping(await repo({ Makefile: "types:\n\tmypy --strict src\n" }));
		expect(r.numerator).toBe(1);
	});

	test("fails (skippable concept still applies) when not strict", async () => {
		const r = await strictTyping(await repo({ "pyproject.toml": "[tool.mypy]\n" }));
		expect(r.numerator).toBe(0);
		expect(r.naKind).toBeUndefined();
	});
});

describe("formatter", () => {
	test("passes with a [tool.black] table", async () => {
		expect((await formatter(await repo({ "pyproject.toml": "[tool.black]\n" }))).numerator).toBe(1);
	});

	test("passes when ruff format is wired via tooling", async () => {
		const r = await formatter(await repo({ Makefile: "fmt:\n\truff format .\n" }));
		expect(r.numerator).toBe(1);
	});

	test("fails with no formatter", async () => {
		expect((await formatter(await repo({ "pyproject.toml": "[project]\n" }))).numerator).toBe(0);
	});
});

describe("namingConsistency", () => {
	test("passes with a pylint config (naming on by default)", async () => {
		expect(
			(await namingConsistency(await repo({ ".pylintrc": "[MESSAGES CONTROL]\n" }))).numerator,
		).toBe(1);
	});

	test("passes when ruff selects pep8-naming N rules", async () => {
		const r = await namingConsistency(
			await repo({ "pyproject.toml": '[tool.ruff.lint]\nselect = ["E", "F", "N"]\n' }),
		);
		expect(r.numerator).toBe(1);
	});

	test("fails when only ruff defaults are configured (no naming rules)", async () => {
		const r = await namingConsistency(
			await repo({ "pyproject.toml": "[tool.ruff]\nline-length = 100\n" }),
		);
		expect(r.numerator).toBe(0);
		expect(r.naKind).toBeUndefined();
	});
});

describe("deadCodeDetection", () => {
	test("passes with a [tool.vulture] table", async () => {
		expect(
			(await deadCodeDetection(await repo({ "pyproject.toml": "[tool.vulture]\n" }))).numerator,
		).toBe(1);
	});

	test("passes when vulture is wired via tooling", async () => {
		const r = await deadCodeDetection(await repo({ Makefile: "deadcode:\n\tvulture src\n" }));
		expect(r.numerator).toBe(1);
	});

	test("fails with no dead-code analyzer", async () => {
		expect(
			(await deadCodeDetection(await repo({ "pyproject.toml": "[project]\n" }))).numerator,
		).toBe(0);
	});
});

describe("duplicateCodeDetection", () => {
	test("passes with a jscpd config", async () => {
		expect((await duplicateCodeDetection(await repo({ ".jscpd.json": "{}" }))).numerator).toBe(1);
	});

	test("passes with a pylint config (duplicate-code on by default)", async () => {
		expect((await duplicateCodeDetection(await repo({ pylintrc: "[MASTER]\n" }))).numerator).toBe(
			1,
		);
	});

	test("fails with no duplicate detector", async () => {
		expect(
			(await duplicateCodeDetection(await repo({ "pyproject.toml": "[project]\n" }))).numerator,
		).toBe(0);
	});
});

describe("unusedDependenciesDetection", () => {
	test("passes with a [tool.deptry] table (Python HAS an analogue, unlike Swift)", async () => {
		const r = await unusedDependenciesDetection(
			await repo({ "pyproject.toml": "[tool.deptry]\n" }),
		);
		expect(r.numerator).toBe(1);
	});

	test("passes when deptry is wired via tooling", async () => {
		const r = await unusedDependenciesDetection(await repo({ Makefile: "deps:\n\tdeptry .\n" }));
		expect(r.numerator).toBe(1);
	});

	test("fails (not N/A) when no analyzer is configured", async () => {
		const r = await unusedDependenciesDetection(await repo({ "pyproject.toml": "[project]\n" }));
		expect(r.numerator).toBe(0);
		expect(r.naKind).toBeUndefined();
	});
});

describe("cyclomaticComplexity", () => {
	test("passes with a ruff mccabe table", async () => {
		const r = await cyclomaticComplexity(
			await repo({ "pyproject.toml": "[tool.ruff.lint.mccabe]\nmax-complexity = 10\n" }),
		);
		expect(r.numerator).toBe(1);
	});

	test("passes with flake8 max-complexity in setup.cfg", async () => {
		const r = await cyclomaticComplexity(
			await repo({ "setup.cfg": "[flake8]\nmax-complexity = 10\n" }),
		);
		expect(r.numerator).toBe(1);
	});

	test("passes when radon is wired via tooling", async () => {
		const r = await cyclomaticComplexity(await repo({ Makefile: "cc:\n\tradon cc src\n" }));
		expect(r.numerator).toBe(1);
	});

	test("fails when complexity is not capped at all", async () => {
		expect(
			(await cyclomaticComplexity(await repo({ "pyproject.toml": "[tool.ruff]\n" }))).numerator,
		).toBe(0);
	});
});
