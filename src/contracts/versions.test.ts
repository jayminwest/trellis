import { describe, expect, test } from "bun:test";
import { SCHEMA_VERSION, SCORING_VERSION, versionStringSchema } from "./versions.ts";

describe("versionStringSchema", () => {
	test("accepts a plain semver core", () => {
		expect(versionStringSchema.safeParse("1.0.0").success).toBe(true);
	});

	test("accepts a pre-release tag", () => {
		expect(versionStringSchema.safeParse("0.1.0-provisional").success).toBe(true);
	});

	test("rejects an empty string", () => {
		expect(versionStringSchema.safeParse("").success).toBe(false);
	});

	test("rejects a partial version", () => {
		expect(versionStringSchema.safeParse("1.0").success).toBe(false);
	});

	test("rejects a non-numeric core", () => {
		expect(versionStringSchema.safeParse("v1.0.0").success).toBe(false);
	});
});

describe("version constants", () => {
	test("the schema and scoring versions satisfy the version schema", () => {
		expect(versionStringSchema.safeParse(SCHEMA_VERSION).success).toBe(true);
		expect(versionStringSchema.safeParse(SCORING_VERSION).success).toBe(true);
	});

	test("the initial scoring version is provisional (SPEC §7)", () => {
		expect(SCORING_VERSION).toContain("provisional");
	});
});
