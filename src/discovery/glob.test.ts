import { describe, expect, test } from "bun:test";
import { matchAnyGlob, matchGlob } from "./glob.ts";

describe("matchGlob literals", () => {
	test("matches an exact path", () => {
		expect(matchGlob("src/index.ts", "src/index.ts")).toBe(true);
	});

	test("does not match a different path or a descendant without a glob", () => {
		expect(matchGlob("src/generated", "src/generated/foo.ts")).toBe(false);
		expect(matchGlob("src", "src/index.ts")).toBe(false);
	});
});

describe("matchGlob * and ?", () => {
	test("* matches within one segment but never crosses '/'", () => {
		expect(matchGlob("src/*.ts", "src/index.ts")).toBe(true);
		expect(matchGlob("src/*.ts", "src/deep/index.ts")).toBe(false);
	});

	test("? matches exactly one character", () => {
		expect(matchGlob("src/?.ts", "src/a.ts")).toBe(true);
		expect(matchGlob("src/?.ts", "src/ab.ts")).toBe(false);
		expect(matchGlob("src/?.ts", "src/.ts")).toBe(false);
	});

	test("regex specials in literals match literally", () => {
		expect(matchGlob("src/foo+bar.(ts)", "src/foo+bar.(ts)")).toBe(true);
		expect(matchGlob("src/foo+bar.(ts)", "src/foo+barr(ts)")).toBe(false);
	});
});

describe("matchGlob **", () => {
	test("a leading ** matches zero or more segments", () => {
		expect(matchGlob("**/*.test.ts", "a.test.ts")).toBe(true);
		expect(matchGlob("**/*.test.ts", "src/deep/a.test.ts")).toBe(true);
	});

	test("a trailing ** matches the base itself and every descendant", () => {
		expect(matchGlob("src/generated/**", "src/generated")).toBe(true);
		expect(matchGlob("src/generated/**", "src/generated/a/b.ts")).toBe(true);
		expect(matchGlob("src/generated/**", "src/other/b.ts")).toBe(false);
	});

	test("a middle ** matches zero or more segments", () => {
		expect(matchGlob("a/**/b.ts", "a/b.ts")).toBe(true);
		expect(matchGlob("a/**/b.ts", "a/x/y/b.ts")).toBe(true);
		expect(matchGlob("a/**/b.ts", "a/x/y/c.ts")).toBe(false);
	});

	test("** alone matches everything", () => {
		expect(matchGlob("**", "any/path/at/all.ts")).toBe(true);
	});
});

describe("matchAnyGlob", () => {
	test("true when any pattern matches; false for an empty pattern list", () => {
		expect(matchAnyGlob(["a/**", "b/**"], "b/x.ts")).toBe(true);
		expect(matchAnyGlob([], "b/x.ts")).toBe(false);
	});
});
