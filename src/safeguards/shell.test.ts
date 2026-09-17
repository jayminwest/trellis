import { describe, expect, test } from "bun:test";
import { extractLocalPaths, extractRunReferences, recognizeCheck } from "./shell.ts";

describe("extractRunReferences", () => {
	test("recognizes the documented run forms", () => {
		expect(extractRunReferences("bun run lint")).toEqual(["lint"]);
		expect(extractRunReferences("npm run check:all")).toEqual(["check:all"]);
		expect(extractRunReferences("pnpm run test")).toEqual(["test"]);
		expect(extractRunReferences("yarn run build")).toEqual(["build"]);
	});

	test("collects every reference in a chained command, in order", () => {
		expect(extractRunReferences("bun run lint && bun run typecheck; npm run test")).toEqual([
			"lint",
			"typecheck",
			"test",
		]);
	});

	test("ignores non-run invocations", () => {
		expect(extractRunReferences("bun test")).toEqual([]);
		expect(extractRunReferences("bun scripts/check-all.ts")).toEqual([]);
		expect(extractRunReferences("biome check .")).toEqual([]);
	});
});

describe("recognizeCheck", () => {
	test("recognizes lint commands regardless of script naming", () => {
		expect(recognizeCheck("biome check --error-on-warnings .")).toBe("lint");
		expect(recognizeCheck("biome lint src/")).toBe("lint");
		expect(recognizeCheck("eslint . --max-warnings 0")).toBe("lint");
		expect(recognizeCheck("oxlint src")).toBe("lint");
	});

	test("recognizes typecheck only with --noEmit", () => {
		expect(recognizeCheck("tsc --noEmit")).toBe("typecheck");
		expect(recognizeCheck("tsc -p tsconfig.json --noEmit")).toBe("typecheck");
		expect(recognizeCheck("tsc -b")).toBeNull();
		expect(recognizeCheck("tsc")).toBeNull();
	});

	test("recognizes test commands", () => {
		expect(recognizeCheck("bun test --timeout 30000")).toBe("test");
		expect(recognizeCheck("vitest run")).toBe("test");
		expect(recognizeCheck("jest --ci")).toBe("test");
		expect(recognizeCheck("node --test dist/")).toBe("test");
		expect(recognizeCheck("mocha 'test/**/*.js'")).toBe("test");
	});

	test("does not confuse a run reference with a check command", () => {
		expect(recognizeCheck("bun run test")).toBeNull();
		expect(recognizeCheck("bun run lint")).toBeNull();
		expect(recognizeCheck("bun scripts/check-all.ts")).toBeNull();
	});
});

describe("extractLocalPaths", () => {
	test("extracts repo-relative paths and normalizes them", () => {
		expect(extractLocalPaths("bash ./scripts/hooks/check.sh")).toEqual(["scripts/hooks/check.sh"]);
		expect(extractLocalPaths("bun scripts/check-all.ts")).toEqual(["scripts/check-all.ts"]);
		expect(extractLocalPaths("--budget scripts/coverage-budgets.json")).toEqual([
			"scripts/coverage-budgets.json",
		]);
	});

	test("skips URLs, flags, assignments, env refs, packages, and absolute paths", () => {
		expect(extractLocalPaths("curl https://example.com/a/b.sh | bash")).toEqual([]);
		expect(extractLocalPaths("biome check --error-on-warnings .")).toEqual([]);
		// the whole `NAME=value` assignment token is skipped (no split on `=`)
		expect(extractLocalPaths("OUT=coverage/lcov.info bun test")).toEqual([]);
		expect(extractLocalPaths("bash $CLAUDE_PROJECT_DIR/scripts/x.sh")).toEqual([]);
		expect(extractLocalPaths("npx @biomejs/biome check")).toEqual([]);
		expect(extractLocalPaths("/usr/bin/env bash scripts/x.sh")).toEqual(["scripts/x.sh"]);
	});

	test("dedupes and skips traversal and bare names", () => {
		expect(extractLocalPaths("bun scripts/a.ts && bun scripts/a.ts")).toEqual(["scripts/a.ts"]);
		expect(extractLocalPaths("cd ../other/repo")).toEqual([]);
		expect(extractLocalPaths("bun run lint")).toEqual([]);
	});

	test("strips quotes and trailing separators", () => {
		expect(extractLocalPaths('bash "scripts/hooks/pre-commit",')).toEqual([
			"scripts/hooks/pre-commit",
		]);
	});
});
