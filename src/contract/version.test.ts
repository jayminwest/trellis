import { describe, expect, test } from "bun:test";
import { VERSION } from "../index.ts";
import { isRepoRelativePath, versionStringSchema } from "./primitives.ts";
import { rollUpCompleteness } from "./states.ts";
import { ANALYZER_VERSION, SCHEMA_VERSION, SCORING_VERSION } from "./version.ts";

describe("contract version constants", () => {
	test("pins the schema version for the §6 contract family", () => {
		expect(SCHEMA_VERSION).toBe("1.0.0");
	});

	test("pins the provisional scoring version from SPEC §7", () => {
		expect(SCORING_VERSION).toBe("0.2.0-provisional");
	});

	test("aliases the analyzer version from the package version", () => {
		expect(ANALYZER_VERSION).toBe(VERSION);
	});
});

describe("versionStringSchema", () => {
	test("accepts plain and prerelease semantic versions", () => {
		expect(versionStringSchema.safeParse("1.0.0").success).toBe(true);
		expect(versionStringSchema.safeParse("0.2.0-provisional").success).toBe(true);
		expect(versionStringSchema.safeParse("0.1.0-rc.1").success).toBe(true);
	});

	test("rejects partial, prefixed, and empty versions", () => {
		expect(versionStringSchema.safeParse("1.0").success).toBe(false);
		expect(versionStringSchema.safeParse("v1.0.0").success).toBe(false);
		expect(versionStringSchema.safeParse("").success).toBe(false);
	});
});

describe("isRepoRelativePath", () => {
	test("accepts nested repo-relative POSIX paths", () => {
		expect(isRepoRelativePath("src/report/build.ts")).toBe(true);
		expect(isRepoRelativePath("trellis.yaml")).toBe(true);
	});

	test("rejects absolute, traversal, drive, and backslash paths", () => {
		expect(isRepoRelativePath("/abs/path")).toBe(false);
		expect(isRepoRelativePath("../outside.ts")).toBe(false);
		expect(isRepoRelativePath("src/../escape.ts")).toBe(false);
		expect(isRepoRelativePath("C:\\repo\\file.ts")).toBe(false);
		expect(isRepoRelativePath("src\\file.ts")).toBe(false);
		expect(isRepoRelativePath("")).toBe(false);
		expect(isRepoRelativePath("src//file.ts")).toBe(false);
	});
});

describe("rollUpCompleteness", () => {
	test("rolls up to complete when no metric is incomplete", () => {
		expect(rollUpCompleteness([])).toBe("complete");
		expect(rollUpCompleteness(["complete", "unsupported", "not-applicable"])).toBe("complete");
	});

	test("rolls up to incomplete when any metric is incomplete", () => {
		expect(rollUpCompleteness(["complete", "incomplete"])).toBe("incomplete");
		expect(rollUpCompleteness(["incomplete"])).toBe("incomplete");
	});
});
