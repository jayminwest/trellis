import { describe, expect, test } from "bun:test";
import { EVIDENCE_LEVELS, safeguardResultSchema } from "./safeguard.ts";

const base = {
	id: "pre-commit-hook",
	evidence: "structurally-wired",
	locations: [{ path: "scripts/hooks/pre-commit" }],
	notes: "invoked via core.hooksPath; check:all referenced from CI",
};

describe("safeguardResultSchema", () => {
	test("round-trips a well-formed safeguard result", () => {
		expect(safeguardResultSchema.parse(base)).toEqual(base);
	});

	test("accepts every documented evidence level", () => {
		for (const evidence of EVIDENCE_LEVELS) {
			expect(safeguardResultSchema.safeParse({ ...base, evidence }).success).toBe(true);
		}
	});

	test("rejects an undocumented evidence level", () => {
		expect(safeguardResultSchema.safeParse({ ...base, evidence: "passing" }).success).toBe(false);
	});

	test("accepts an absent safeguard with no locations", () => {
		const result = safeguardResultSchema.safeParse({
			id: "pre-commit-hook",
			evidence: "absent",
			locations: [],
		});
		expect(result.success).toBe(true);
	});

	test("accepts a location with a pinpointed range", () => {
		const result = safeguardResultSchema.safeParse({
			...base,
			locations: [
				{ path: ".github/workflows/ci.yml", range: { start: { line: 9 }, end: { line: 12 } } },
			],
		});
		expect(result.success).toBe(true);
	});

	test("rejects unknown keys", () => {
		expect(safeguardResultSchema.safeParse({ ...base, passes: true }).success).toBe(false);
	});
});
