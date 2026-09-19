import { describe, expect, test } from "bun:test";
import type { Finding } from "../contract/index.ts";
import { cloneReviewContext } from "./clone-context.ts";

const finding: Finding = {
	kind: "duplication.clone-group",
	path: "a.ts",
	range: { start: { line: 1 }, end: { line: 9 } },
	summary: "copies",
};

describe("cloneReviewContext", () => {
	test("keeps absent, invalid and future overlap metadata unknown", () => {
		for (const lineOverlap of [
			undefined,
			{},
			{ version: 2, overlaps: false },
			{ version: 1, overlaps: false, memberIndexes: [0, 1], spans: [] },
		]) {
			expect(cloneReviewContext({ ...finding, facts: { lineOverlap } })).toContain("unknown");
		}
		expect(cloneReviewContext({ ...finding, kind: "import-cycle" })).toBe("");
	});

	test("renders guidance only for observed overlap", () => {
		expect(
			cloneReviewContext({
				...finding,
				facts: { lineOverlap: { version: 1, overlaps: false, memberIndexes: [], spans: [] } },
			}),
		).toBe("");
		const context = cloneReviewContext({
			...finding,
			facts: {
				lineOverlap: {
					version: 1,
					overlaps: true,
					memberIndexes: [0, 1],
					spans: [{ path: "a.ts", startLine: 3, endLine: 5 }],
				},
			},
		});
		expect(context).toContain("review the repeated structure");
		expect(context).toContain("does not prove token overlap");
	});
});
