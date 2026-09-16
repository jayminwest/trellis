import { describe, expect, test } from "bun:test";
import { auditConfigSchema, metricBudgetSchema, parseAuditConfig } from "./schema.ts";

describe("auditConfigSchema", () => {
	test("defaults every section when the config is empty", () => {
		expect(auditConfigSchema.parse({})).toEqual({
			source: { exclude: [], classify: {} },
			policy: { budgets: {}, failOnNew: [] },
		});
	});

	test("round-trips the SPEC §6.5 example shape", () => {
		const config = {
			source: {
				exclude: ["src/generated/**"],
				classify: { "scripts/tools/**": "test" },
			},
			policy: {
				maxIndex: 40,
				budgets: { "duplication.density": { max: 0.05 } },
				failOnNew: ["import-cycle", "complexity.hotspot"],
			},
		};
		expect(auditConfigSchema.parse(config)).toEqual(config);
	});

	test("rejects executable hook keys — configuration is data, not code", () => {
		const result = auditConfigSchema.safeParse({
			hooks: { "pre-audit": "rm -rf /" },
		});
		expect(result.success).toBe(false);
	});

	test("rejects unknown keys inside a section", () => {
		const result = auditConfigSchema.safeParse({
			source: { exclude: [], classify: {}, run: "make audit" },
		});
		expect(result.success).toBe(false);
	});

	test("rejects an undocumented source-set classification", () => {
		const result = auditConfigSchema.safeParse({
			source: { classify: { "scripts/**": "fixtures" } },
		});
		expect(result.success).toBe(false);
	});

	test("rejects an out-of-range maxIndex", () => {
		const result = auditConfigSchema.safeParse({ policy: { maxIndex: 101 } });
		expect(result.success).toBe(false);
	});

	test("rejects an empty exclude glob", () => {
		const result = auditConfigSchema.safeParse({ source: { exclude: [""] } });
		expect(result.success).toBe(false);
	});
});

describe("metricBudgetSchema", () => {
	test("accepts a max-only budget", () => {
		expect(metricBudgetSchema.parse({ max: 0.05 })).toEqual({ max: 0.05 });
	});

	test("accepts a min-only budget", () => {
		expect(metricBudgetSchema.parse({ min: 0.8 })).toEqual({ min: 0.8 });
	});

	test("rejects an empty budget", () => {
		expect(metricBudgetSchema.safeParse({}).success).toBe(false);
	});

	test("rejects an inverted min/max range", () => {
		expect(metricBudgetSchema.safeParse({ min: 0.9, max: 0.1 }).success).toBe(false);
	});

	test("rejects a non-finite bound", () => {
		expect(metricBudgetSchema.safeParse({ max: Number.POSITIVE_INFINITY }).success).toBe(false);
	});
});

describe("parseAuditConfig", () => {
	test("validates unknown data", () => {
		expect(parseAuditConfig({ policy: { maxIndex: 40 } }).policy.maxIndex).toBe(40);
	});

	test("throws on invalid data", () => {
		expect(() => parseAuditConfig({ policy: { maxIndex: -1 } })).toThrow();
	});
});
