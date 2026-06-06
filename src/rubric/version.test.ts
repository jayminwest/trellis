import { describe, expect, test } from "bun:test";
import { comparable, RUBRIC_VERSION } from "./version.ts";

describe("RUBRIC_VERSION", () => {
	test("is the SPEC §6.1 pinned version", () => {
		expect(RUBRIC_VERSION).toBe("0.2.0");
	});

	test("is a valid X.Y.Z string", () => {
		expect(RUBRIC_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
	});
});

describe("comparable", () => {
	test("identical versions are comparable", () => {
		expect(comparable("0.2.0", "0.2.0")).toBe(true);
	});

	test("pre-1.0 patch bumps stay comparable", () => {
		expect(comparable("0.2.0", "0.2.3")).toBe(true);
	});

	test("pre-1.0 minor bumps break comparability (comparability rides minor)", () => {
		expect(comparable("0.2.0", "0.3.0")).toBe(false);
	});

	test("post-1.0 minor/patch bumps stay comparable", () => {
		expect(comparable("1.0.0", "1.4.2")).toBe(true);
	});

	test("major bumps break comparability", () => {
		expect(comparable("1.0.0", "2.0.0")).toBe(false);
	});

	test("a 0.x version is never comparable to a 1.x version", () => {
		expect(comparable("0.9.0", "1.0.0")).toBe(false);
	});

	test("throws on a malformed version", () => {
		expect(() => comparable("0.2", "0.2.0")).toThrow();
	});
});
