import { describe, expect, test } from "bun:test";
import { type AuditConfig, auditConfigSchema } from "./config.ts";

/** The SPEC §6.5 example as parsed YAML data. */
const specExample: AuditConfig = {
	source: {
		exclude: ["src/generated/**"],
		classify: { "scripts/tools/**": "test" },
	},
	policy: {
		maxIndex: 40,
		budgets: { "duplication.density": { max: 0.05 } },
		failOnNew: ["import-cycle", "complexity.hotspot"],
		requireEvidence: ["jscpd"],
	},
};

describe("auditConfigSchema", () => {
	test("round-trips the SPEC §6.5 example", () => {
		expect(auditConfigSchema.parse(specExample)).toEqual(specExample);
	});

	test("fills sensible defaults from an empty configuration", () => {
		expect(auditConfigSchema.parse({})).toEqual({
			source: { exclude: [], classify: {} },
			policy: { budgets: {}, failOnNew: [], requireEvidence: [] },
		});
	});

	test("rejects executable hooks — configuration is data, not code", () => {
		expect(
			auditConfigSchema.safeParse({ hooks: { preAudit: "node scripts/hook.js" } }).success,
		).toBe(false);
		expect(
			auditConfigSchema.safeParse({ source: { ...specExample.source, run: "rm -rf /" } }).success,
		).toBe(false);
	});

	test("rejects scoring-weight overrides — policy never mutates the formula", () => {
		const policy = { ...specExample.policy, weights: { duplication: 0.9 } };
		expect(auditConfigSchema.safeParse({ source: specExample.source, policy }).success).toBe(false);
	});

	test("round-trips a regression policy with absolute and relative tolerances", () => {
		const policy = {
			...specExample.policy,
			regression: { maxIncrease: 2, maxIncreasePercent: 10 },
		};
		expect(auditConfigSchema.parse({ policy }).policy.regression).toEqual({
			maxIncrease: 2,
			maxIncreasePercent: 10,
		});
	});

	test("rejects out-of-range regression tolerances", () => {
		for (const regression of [
			{ maxIncrease: -1 },
			{ maxIncrease: 101 },
			{ maxIncreasePercent: -5 },
			{ maxIncrease: Number.NaN },
		]) {
			expect(auditConfigSchema.safeParse({ policy: { regression } }).success).toBe(false);
		}
	});

	test("rejects unknown keys inside the regression block", () => {
		const policy = { regression: { maxIncrease: 2, weight: 0.5 } };
		expect(auditConfigSchema.safeParse({ policy }).success).toBe(false);
	});

	test("rejects an out-of-range maxIndex", () => {
		const policy = { ...specExample.policy, maxIndex: 101 };
		expect(auditConfigSchema.safeParse({ source: specExample.source, policy }).success).toBe(false);
	});

	test("rejects negative and non-finite budget ceilings", () => {
		for (const max of [-0.05, Number.POSITIVE_INFINITY, Number.NaN]) {
			const policy = { budgets: { "duplication.density": { max } } };
			expect(auditConfigSchema.safeParse({ policy }).success).toBe(false);
		}
	});

	test("rejects classification to a scope that is not a source set", () => {
		const source = { classify: { "scripts/**": "scored" } };
		expect(auditConfigSchema.safeParse({ source }).success).toBe(false);
	});

	test("rejects malformed budget metric ids and failOnNew kinds", () => {
		expect(
			auditConfigSchema.safeParse({ policy: { budgets: { "Bad Id": { max: 1 } } } }).success,
		).toBe(false);
		expect(auditConfigSchema.safeParse({ policy: { failOnNew: ["Import Cycle"] } }).success).toBe(
			false,
		);
	});

	test("round-trips provider-evidence requirements over supported analysis ids", () => {
		const policy = { ...specExample.policy, requireEvidence: ["jscpd", "sonarjs"] };
		expect(auditConfigSchema.parse({ policy }).policy.requireEvidence).toEqual([
			"jscpd",
			"sonarjs",
		]);
	});

	test("rejects native analyzer ids and evidence ids as requirements, actionably", () => {
		for (const id of ["trellis.complexity", "trellis.duplication", "provider.jscpd.pairs"]) {
			const parsed = auditConfigSchema.safeParse({ policy: { requireEvidence: [id] } });
			expect(parsed.success).toBe(false);
			if (!parsed.success) {
				expect(parsed.error.issues[0]?.path.join(".")).toBe("policy.requireEvidence.0");
				expect(parsed.error.issues[0]?.message).toMatch(/requireEvidence|analysis id/);
			}
		}
	});

	test("rejects command strings and executable requirement objects — requirements are ids, never code", () => {
		for (const id of [
			"jscpd --min-tokens 50",
			"npm install jscpd",
			"./run-jscpd.sh",
			"",
			"Jscpd",
		]) {
			expect(auditConfigSchema.safeParse({ policy: { requireEvidence: [id] } }).success).toBe(
				false,
			);
		}
		expect(
			auditConfigSchema.safeParse({
				policy: { requireEvidence: [{ id: "jscpd", command: "jscpd --min-tokens 50" }] },
			}).success,
		).toBe(false);
	});

	test("rejects empty glob strings", () => {
		expect(auditConfigSchema.safeParse({ source: { exclude: [""] } }).success).toBe(false);
	});
});
