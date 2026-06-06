import { describe, expect, test } from "bun:test";
import { categoryRecordSchema, criterionRecordSchema } from "./schema.ts";

describe("categoryRecordSchema", () => {
	test("round-trips a well-formed category record", () => {
		const input = { id: "documentation", title: "Documentation", description: "Docs scope." };
		expect(categoryRecordSchema.parse(input)).toEqual(input);
	});

	test("rejects a non-snake_case id", () => {
		const result = categoryRecordSchema.safeParse({
			id: "Documentation",
			title: "Documentation",
			description: "Docs scope.",
		});
		expect(result.success).toBe(false);
	});

	test("rejects an empty description", () => {
		const result = categoryRecordSchema.safeParse({
			id: "documentation",
			title: "Documentation",
			description: "",
		});
		expect(result.success).toBe(false);
	});

	test("rejects unknown keys", () => {
		const result = categoryRecordSchema.safeParse({
			id: "documentation",
			title: "Documentation",
			description: "Docs scope.",
			extra: true,
		});
		expect(result.success).toBe(false);
	});
});

describe("criterionRecordSchema", () => {
	const base = {
		id: "agents_md",
		category: "documentation",
		scope: "repo",
		level: 1,
		skippable: false,
		discoveryVia: "deterministic",
	} as const;

	test("round-trips and fills reserved defaults", () => {
		const parsed = criterionRecordSchema.parse(base);
		expect(parsed).toEqual({
			...base,
			investigation: null,
			gate: false,
			weight: 1,
		});
	});

	test("preserves explicit reserved fields", () => {
		const parsed = criterionRecordSchema.parse({ ...base, gate: true, weight: 2.5 });
		expect(parsed.gate).toBe(true);
		expect(parsed.weight).toBe(2.5);
	});

	test("accepts an agent criterion with a non-null investigation area", () => {
		const parsed = criterionRecordSchema.parse({
			...base,
			id: "setup_runnable",
			discoveryVia: "agent",
			investigation: "setup-runnability",
		});
		expect(parsed.investigation).toBe("setup-runnability");
	});

	test("rejects an agent criterion with null investigation", () => {
		const result = criterionRecordSchema.safeParse({ ...base, discoveryVia: "agent" });
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0]?.message).toContain("non-null");
		}
	});

	test("rejects a deterministic criterion carrying an investigation area", () => {
		const result = criterionRecordSchema.safeParse({
			...base,
			discoveryVia: "deterministic",
			investigation: "documentation",
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0]?.message).toContain("null");
		}
	});

	test("rejects a non-positive weight", () => {
		expect(criterionRecordSchema.safeParse({ ...base, weight: 0 }).success).toBe(false);
		expect(criterionRecordSchema.safeParse({ ...base, weight: -1 }).success).toBe(false);
	});

	test("rejects a level outside 1..5", () => {
		expect(criterionRecordSchema.safeParse({ ...base, level: 0 }).success).toBe(false);
		expect(criterionRecordSchema.safeParse({ ...base, level: 6 }).success).toBe(false);
		expect(criterionRecordSchema.safeParse({ ...base, level: 2.5 }).success).toBe(false);
	});

	test("rejects an unknown scope", () => {
		expect(criterionRecordSchema.safeParse({ ...base, scope: "module" }).success).toBe(false);
	});

	test("rejects an unknown investigation area", () => {
		const result = criterionRecordSchema.safeParse({
			...base,
			discoveryVia: "agent",
			investigation: "performance",
		});
		expect(result.success).toBe(false);
	});
});
