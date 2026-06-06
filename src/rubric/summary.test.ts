import { describe, expect, test } from "bun:test";
import type { Rubric } from "./loader.ts";
import { summarizeRubric } from "./summary.ts";
import { RUBRIC_VERSION } from "./version.ts";

/** A two-category rubric exercising the repo/app split and the level histogram. */
const RUBRIC: Rubric = {
	categories: [
		{ id: "documentation", title: "Documentation", description: "Docs." },
		{ id: "testing", title: "Testing", description: "Tests." },
	],
	criteria: [
		{
			id: "agents_md",
			category: "documentation",
			scope: "repo",
			level: 1,
			skippable: false,
			discoveryVia: "deterministic",
			investigation: null,
			gate: true,
			weight: 1,
		},
		{
			id: "readme_quality",
			category: "documentation",
			scope: "repo",
			level: 1,
			skippable: false,
			discoveryVia: "agent",
			investigation: "documentation",
			gate: false,
			weight: 1,
		},
		{
			id: "test_layout",
			category: "testing",
			scope: "app",
			level: 3,
			skippable: false,
			discoveryVia: "agent",
			investigation: "test-layout",
			gate: true,
			weight: 1,
		},
	],
};

describe("summarizeRubric", () => {
	test("reports the rubric version and whole-rubric totals", () => {
		const summary = summarizeRubric(RUBRIC);
		expect(summary.rubricVersion).toBe(RUBRIC_VERSION);
		expect(summary.categoryCount).toBe(2);
		expect(summary.criterionCount).toBe(3);
	});

	test("keeps categories in categories.yaml order", () => {
		const summary = summarizeRubric(RUBRIC);
		expect(summary.categories.map((c) => c.id)).toEqual(["documentation", "testing"]);
	});

	test("counts criteria with the repo/app split per category", () => {
		const [docs, testing] = summarizeRubric(RUBRIC).categories;
		expect(docs).toMatchObject({ criterionCount: 2, repo: 2, app: 0 });
		expect(testing).toMatchObject({ criterionCount: 1, repo: 0, app: 1 });
	});

	test("builds a zero-filled level histogram", () => {
		const [docs, testing] = summarizeRubric(RUBRIC).categories;
		expect(docs?.levels).toEqual({ 1: 2, 2: 0, 3: 0, 4: 0, 5: 0 });
		expect(testing?.levels).toEqual({ 1: 0, 2: 0, 3: 1, 4: 0, 5: 0 });
	});

	test("surfaces the single gate criterion id per category", () => {
		const [docs, testing] = summarizeRubric(RUBRIC).categories;
		expect(docs?.gate).toBe("agents_md");
		expect(testing?.gate).toBe("test_layout");
	});

	test("reports a null gate for a category with no criteria", () => {
		const summary = summarizeRubric({
			categories: [{ id: "empty", title: "Empty", description: "None." }],
			criteria: [],
		});
		expect(summary.categories[0]).toMatchObject({ criterionCount: 0, gate: null });
	});
});
