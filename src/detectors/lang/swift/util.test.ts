import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDetectionContext } from "../../context.ts";
import type { DetectionContext } from "../../types.ts";
import {
	findSwiftlintConfig,
	firstPresent,
	gatherToolingText,
	swiftlintDefaultRuleEnabled,
	toolingMentions,
} from "./util.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function repo(files: Record<string, string>): Promise<DetectionContext> {
	const root = await mkdtemp(join(tmpdir(), "trellis-swift-util-"));
	dirs.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(root, rel);
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, content);
	}
	return createDetectionContext(root, { path: ".", languages: ["swift"] });
}

describe("findSwiftlintConfig", () => {
	test("returns {} for an empty-but-present config (defaults apply)", async () => {
		const cfg = await findSwiftlintConfig(await repo({ ".swiftlint.yml": "" }));
		expect(cfg).not.toBeNull();
		expect(cfg?.path).toBe(".swiftlint.yml");
		expect(cfg?.config).toEqual({});
	});

	test("parses .swiftlint.yaml with rules", async () => {
		const cfg = await findSwiftlintConfig(
			await repo({ ".swiftlint.yaml": "disabled_rules:\n  - todo\n" }),
		);
		expect(cfg?.config.disabled_rules).toEqual(["todo"]);
	});

	test("returns null when absent", async () => {
		expect(await findSwiftlintConfig(await repo({ "Package.swift": "// swift\n" }))).toBeNull();
	});
});

describe("swiftlintDefaultRuleEnabled", () => {
	test("a default rule is on when not disabled", () => {
		expect(swiftlintDefaultRuleEnabled({}, "identifier_name")).toBe(true);
	});

	test("a default rule is off when in disabled_rules", () => {
		expect(
			swiftlintDefaultRuleEnabled({ disabled_rules: ["identifier_name"] }, "identifier_name"),
		).toBe(false);
	});

	test("only_rules acts as an allowlist", () => {
		expect(swiftlintDefaultRuleEnabled({ only_rules: ["type_name"] }, "identifier_name")).toBe(
			false,
		);
		expect(
			swiftlintDefaultRuleEnabled({ only_rules: ["identifier_name"] }, "identifier_name"),
		).toBe(true);
	});
});

describe("firstPresent", () => {
	test("returns the first existing candidate in order", async () => {
		const ctx = await repo({ ".swiftformat": "--indent 4\n" });
		expect(await firstPresent(ctx, [".swift-format", ".swiftformat"])).toBe(".swiftformat");
	});

	test("returns null when none exist", async () => {
		expect(await firstPresent(await repo({}), [".swift-format"])).toBeNull();
	});
});

describe("gatherToolingText", () => {
	test("concatenates manifest, build glue, CI, and scripts", async () => {
		const text = await gatherToolingText(
			await repo({
				"Package.swift": "// manifest\n",
				Makefile: "lint:\n\tswiftlint\n",
				".github/workflows/ci.yml": "run: periphery scan\n",
				"scripts/coverage.sh": "llvm-cov report\n",
			}),
		);
		expect(toolingMentions(text, /swiftlint/i)).toBe(true);
		expect(toolingMentions(text, /periphery/i)).toBe(true);
		expect(toolingMentions(text, /llvm-cov/i)).toBe(true);
	});

	test("returns empty string when nothing is present", async () => {
		expect(await gatherToolingText(await repo({}))).toBe("");
	});
});
