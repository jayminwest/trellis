import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND_RULES, checkBrand } from "./index.ts";

const README = [
	"# seeds",
	"[![npm](https://img.shields.io/npm/v/@os-eco/seeds-cli)](https://www.npmjs.com/package/@os-eco/seeds-cli)",
	"[![CI](https://github.com/jayminwest/seeds/actions/workflows/ci.yml/badge.svg)](https://github.com/jayminwest/seeds/actions/workflows/ci.yml)",
	"[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)",
	"",
].join("\n");

const COMMANDS = [
	'program.command("prime");',
	"program.command('onboard');",
	'const setup = program.command("setup");',
	'setup.command("claude");',
].join("\n");

/** Write a fully conforming repo into `root`. */
function seedConforming(root: string): void {
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({
			name: "@os-eco/seeds-cli",
			description: "Git-native issue tracker for AI agents",
			bin: { seeds: "./src/index.ts", sd: "./src/index.ts" },
		}),
	);
	writeFileSync(join(root, "README.md"), README);
	mkdirSync(join(root, "src", "commands"), { recursive: true });
	writeFileSync(join(root, "src", "commands", "all.ts"), COMMANDS);
}

function writePackage(root: string, pkg: Record<string, unknown>): void {
	writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
}

describe("checkBrand", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "trellis-brand-"));
		seedConforming(root);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("reports no findings for a conforming repo", () => {
		const report = checkBrand(root);
		expect(report.findings).toEqual([]);
		expect(report.rules).toEqual([...BRAND_RULES]);
	});

	test("flags a bin without the long name", () => {
		writePackage(root, { name: "@os-eco/seeds-cli", description: "x", bin: { sd: "./i.ts" } });
		expect(checkBrand(root).findings).toEqual([
			{ rule: "bin-pair", detail: 'bin lacks the long name "seeds" (has: sd)' },
		]);
	});

	test("flags a long name with no short alias", () => {
		writePackage(root, { name: "@os-eco/roots-cli", description: "x", bin: { roots: "./i.ts" } });
		expect(checkBrand(root).findings.map((f) => f.rule)).toEqual(["bin-pair"]);
	});

	test("flags an emoji or missing description", () => {
		const bin = { mulch: "./i.ts", ml: "./i.ts" };
		writePackage(root, { name: "@os-eco/mulch-cli", description: "Let agents grow 🌱", bin });
		expect(checkBrand(root).findings[0]?.detail).toContain("emoji");
		writePackage(root, { name: "@os-eco/mulch-cli", bin });
		expect(checkBrand(root).findings[0]?.detail).toBe("package.json has no description");
	});

	test("flags missing README badges by name", () => {
		writeFileSync(join(root, "README.md"), README.split("\n").slice(0, 2).join("\n"));
		expect(checkBrand(root).findings).toEqual([
			{ rule: "readme-badges", detail: "README.md lacks badges: CI, license" },
		]);
		rmSync(join(root, "README.md"));
		expect(checkBrand(root).findings[0]?.detail).toBe("README.md is missing");
	});

	test("flags unregistered commands, ignoring test files", () => {
		writeFileSync(join(root, "src", "commands", "all.ts"), 'program.command("prime");');
		writeFileSync(join(root, "src", "commands", "all.test.ts"), COMMANDS);
		expect(checkBrand(root).findings).toEqual([
			{ rule: "commands", detail: "src/ registers no command: onboard, setup" },
		]);
	});

	test("reports every rule for an empty directory without throwing", () => {
		const empty = mkdtempSync(join(tmpdir(), "trellis-brand-empty-"));
		try {
			expect(checkBrand(empty).findings.map((f) => f.rule)).toEqual([...BRAND_RULES]);
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});
});
