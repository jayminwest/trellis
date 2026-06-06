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

/** Build a Swift fixture package tree and a detection context over it. */
async function repo(
	files: Record<string, string>,
	run?: (argv: string[]) => Promise<ExecResult>,
): Promise<DetectionContext> {
	const root = await mkdtemp(join(tmpdir(), "trellis-swift-cq-"));
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

describe("lintConfig", () => {
	test("passes with a .swiftlint.yml config", async () => {
		const r = await lintConfig(await repo({ ".swiftlint.yml": "disabled_rules:\n  - todo\n" }));
		expect(r.numerator).toBe(1);
	});

	test("passes when SwiftLint is wired via a Makefile", async () => {
		const r = await lintConfig(await repo({ Makefile: "lint:\n\tswiftlint lint --strict\n" }));
		expect(r.numerator).toBe(1);
	});

	test("fails (non-skippable) with no linter at all", async () => {
		const r = await lintConfig(await repo({ "Package.swift": "// swift-tools-version:5.9\n" }));
		expect(r.numerator).toBe(0);
		expect(r.naKind).toBeUndefined();
	});
});

describe("typeCheck", () => {
	test("passes when Package.swift present and swift build runs clean", async () => {
		const r = await typeCheck(await repo({ "Package.swift": "// swift\n" }, async () => exec(0)));
		expect(r.numerator).toBe(1);
	});

	test("invokes `swift build`", async () => {
		let argv: string[] = [];
		await typeCheck(
			await repo({ "Package.swift": "// swift\n" }, async (a) => {
				argv = a;
				return exec(0);
			}),
		);
		expect(argv).toEqual(["swift", "build"]);
	});

	test("fails when the build reports errors", async () => {
		const r = await typeCheck(await repo({ "Package.swift": "// swift\n" }, async () => exec(1)));
		expect(r.numerator).toBe(0);
		expect(r.naKind).toBeUndefined();
	});

	test("no-detector when the toolchain is unavailable (configured but can't run)", async () => {
		const r = await typeCheck(await repo({ "Package.swift": "// swift\n" }, async () => exec(127)));
		expect(r.naKind).toBe("no-detector");
	});

	test("no-detector when the build times out", async () => {
		const r = await typeCheck(
			await repo({ "Package.swift": "// swift\n" }, async () => exec(0, { timedOut: true })),
		);
		expect(r.naKind).toBe("no-detector");
	});

	test("fails when there is no Package.swift", async () => {
		expect((await typeCheck(await repo({}))).numerator).toBe(0);
	});
});

describe("strictTyping", () => {
	test("passes with -warnings-as-errors unsafeFlags in Package.swift", async () => {
		const r = await strictTyping(
			await repo({
				"Package.swift": 'swiftSettings: [.unsafeFlags(["-warnings-as-errors"])]\n',
			}),
		);
		expect(r.numerator).toBe(1);
	});

	test("passes with the Swift 6 treatAllWarnings(as: .error) setting", async () => {
		const r = await strictTyping(
			await repo({ "Package.swift": "swiftSettings: [.treatAllWarnings(as: .error)]\n" }),
		);
		expect(r.numerator).toBe(1);
	});

	test("fails (skippable concept still applies) when warnings are not errors", async () => {
		const r = await strictTyping(await repo({ "Package.swift": "// plain manifest\n" }));
		expect(r.numerator).toBe(0);
		expect(r.naKind).toBeUndefined();
	});

	test("fails when there is no Package.swift", async () => {
		expect((await strictTyping(await repo({}))).numerator).toBe(0);
	});
});

describe("formatter", () => {
	test("passes with a swift-format config", async () => {
		expect((await formatter(await repo({ ".swift-format": "{}" }))).numerator).toBe(1);
	});

	test("passes with a SwiftFormat config", async () => {
		expect((await formatter(await repo({ ".swiftformat": "--indent 4\n" }))).numerator).toBe(1);
	});

	test("fails with no formatter", async () => {
		expect((await formatter(await repo({ "Package.swift": "// swift\n" }))).numerator).toBe(0);
	});
});

describe("namingConsistency", () => {
	test("passes when SwiftLint config leaves naming rules on (default)", async () => {
		const r = await namingConsistency(
			await repo({ ".swiftlint.yml": "disabled_rules:\n  - todo\n" }),
		);
		expect(r.numerator).toBe(1);
	});

	test("fails when SwiftLint config disables both naming rules", async () => {
		const r = await namingConsistency(
			await repo({ ".swiftlint.yml": "disabled_rules:\n  - identifier_name\n  - type_name\n" }),
		);
		expect(r.numerator).toBe(0);
		expect(r.naKind).toBeUndefined();
	});

	test("fails with no SwiftLint at all", async () => {
		expect((await namingConsistency(await repo({ "Package.swift": "// swift\n" }))).numerator).toBe(
			0,
		);
	});
});

describe("deadCodeDetection", () => {
	test("passes with a periphery config", async () => {
		expect((await deadCodeDetection(await repo({ ".periphery.yml": "{}" }))).numerator).toBe(1);
	});

	test("passes when periphery is wired via tooling", async () => {
		const r = await deadCodeDetection(await repo({ Makefile: "deadcode:\n\tperiphery scan\n" }));
		expect(r.numerator).toBe(1);
	});

	test("fails with no dead-code analyzer", async () => {
		expect((await deadCodeDetection(await repo({ "Package.swift": "// swift\n" }))).numerator).toBe(
			0,
		);
	});
});

describe("duplicateCodeDetection", () => {
	test("passes with a jscpd config", async () => {
		expect((await duplicateCodeDetection(await repo({ ".jscpd.json": "{}" }))).numerator).toBe(1);
	});

	test("fails with no duplicate detector", async () => {
		expect(
			(await duplicateCodeDetection(await repo({ "Package.swift": "// swift\n" }))).numerator,
		).toBe(0);
	});
});

describe("unusedDependenciesDetection", () => {
	test("not-applicable — no Swift analogue (SPEC §8.3 N/A)", async () => {
		const r = await unusedDependenciesDetection(await repo({ "Package.swift": "// swift\n" }));
		expect(r.numerator).toBeNull();
		expect(r.naKind).toBe("not-applicable");
		expect(r.rationale).toMatch(/no Swift analogue/i);
	});
});

describe("cyclomaticComplexity", () => {
	test("passes when SwiftLint leaves cyclomatic_complexity on (default)", async () => {
		const r = await cyclomaticComplexity(await repo({ ".swiftlint.yml": "line_length: 120\n" }));
		expect(r.numerator).toBe(1);
	});

	test("fails when SwiftLint disables the complexity rules", async () => {
		const r = await cyclomaticComplexity(
			await repo({
				".swiftlint.yml": "disabled_rules:\n  - cyclomatic_complexity\n  - function_body_length\n",
			}),
		);
		expect(r.numerator).toBe(0);
		expect(r.naKind).toBeUndefined();
	});

	test("fails (non-skippable) when complexity is not capped at all", async () => {
		expect(
			(await cyclomaticComplexity(await repo({ "Package.swift": "// swift\n" }))).numerator,
		).toBe(0);
	});
});
