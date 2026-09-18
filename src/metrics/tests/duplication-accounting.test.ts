import { describe, expect, test } from "bun:test";
import type { SyntaxInventory } from "../../syntax/types.ts";
import { analyzeDuplication } from "../analyze-duplication.ts";
import { referenceScope } from "./duplication-accounting.ts";
import { repeatedSource, sourceFile } from "./duplication-fixtures.ts";

describe("native duplication reference accounting", () => {
	test("counts code-line unions once despite overlapping within-file runs", () => {
		const file = sourceFile("a.ts", repeatedSource("a"));
		const reference = referenceScope([file]);
		expect(reference.codeLines).toBe(27);
		expect(reference.duplicatedLines).toBe(24);
		expect(reference.density).toBe(24 / 27);
		expect(
			reference.groups
				.flatMap((group) => group.members)
				.reduce((sum, member) => sum + member.lineCount, 0),
		).toBeGreaterThan(reference.duplicatedLines);
	});

	test("retains production/test separation and excludes comment-only lines from union numerators", () => {
		const files = [
			sourceFile("a.ts", repeatedSource("a")),
			sourceFile("b.ts", repeatedSource("b").replace(" return x;", " // comment\n\n return x;")),
			sourceFile("a.test.ts", repeatedSource("c"), "test"),
			sourceFile("b.test.ts", repeatedSource("d"), "test"),
		];
		const inventory: SyntaxInventory = {
			root: "/fixture",
			compilerVersion: "test",
			files,
			functionCount: 4,
			diagnostics: [],
			completeness: "complete",
		};
		const actual = analyzeDuplication(inventory);
		for (const scope of ["production", "test"] as const) {
			const reference = referenceScope(files.filter((file) => file.sourceSet === scope));
			expect(reference.codeLines).toBe(54);
			expect(reference.duplicatedLines).toBe(54);
			expect(reference.density).toBe(1);
			expect(reference.tokenCount).toBe(458);
			expect(actual.scopes[scope]).toMatchObject(reference);
		}
		expect(referenceScope([])).toEqual({
			groups: [],
			codeLines: 0,
			duplicatedLines: 0,
			density: null,
			tokenCount: 0,
		});
	});
});
