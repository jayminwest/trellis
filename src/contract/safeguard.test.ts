import { describe, expect, test } from "bun:test";
import { type SafeguardResult, safeguardResultSchema } from "./safeguard.ts";

/** The SPEC §6.3 example: a structurally wired pre-commit hook. */
const wiredHook: SafeguardResult = {
	id: "pre-commit-hook",
	evidence: "structurally-wired",
	locations: [{ path: "scripts/hooks/pre-commit" }],
	notes: "invoked via core.hooksPath; check:all referenced from CI",
};

describe("safeguardResultSchema", () => {
	test("round-trips the SPEC §6.3 example", () => {
		expect(safeguardResultSchema.parse(wiredHook)).toEqual(wiredHook);
	});

	test("accepts an absent safeguard with no locations", () => {
		const parsed = safeguardResultSchema.parse({
			id: "coverage-budget",
			evidence: "absent",
			locations: [],
		});
		expect(parsed.evidence).toBe("absent");
	});

	test("accepts an unknown safeguard without locations", () => {
		const parsed = safeguardResultSchema.parse({
			id: "pre-commit-hook",
			evidence: "unknown",
			locations: [],
			notes: "hook body is arbitrary shell",
		});
		expect(parsed.evidence).toBe("unknown");
	});

	test("accepts a located reference range on a location", () => {
		const parsed = safeguardResultSchema.parse({
			id: "pre-commit-hook",
			evidence: "configured",
			locations: [
				{ path: "scripts/hooks/pre-commit", range: { start: { line: 1 }, end: { line: 4 } } },
			],
		});
		expect(parsed.locations[0]?.range?.end.line).toBe(4);
	});

	test("rejects evidence levels outside the four documented values", () => {
		expect(safeguardResultSchema.safeParse({ ...wiredHook, evidence: "passing" }).success).toBe(
			false,
		);
	});

	test("rejects an absent safeguard carrying locations", () => {
		const result = safeguardResultSchema.safeParse({
			id: "coverage-budget",
			evidence: "absent",
			locations: [{ path: "scripts/check-coverage.ts" }],
		});
		expect(result.success).toBe(false);
	});

	test("rejects configured and structurally-wired safeguards without locations", () => {
		for (const evidence of ["configured", "structurally-wired"]) {
			const result = safeguardResultSchema.safeParse({
				id: "pre-commit-hook",
				evidence,
				locations: [],
			});
			expect(result.success).toBe(false);
		}
	});

	test("rejects non-relative location paths and unknown keys", () => {
		expect(
			safeguardResultSchema.safeParse({ ...wiredHook, locations: [{ path: "/abs/hook" }] }).success,
		).toBe(false);
		expect(safeguardResultSchema.safeParse({ ...wiredHook, extra: true }).success).toBe(false);
	});
});
