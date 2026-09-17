import { describe, expect, test } from "bun:test";
import { SUPPORTED_PROVIDERS } from "../providers/capabilities.ts";
import { type AuditConfig, auditConfigSchema, providerSelectionSchema } from "./config.ts";

/** The SPEC §6.5 example as parsed YAML data. */
const specExample: AuditConfig = {
	source: {
		exclude: ["src/generated/**"],
		classify: { "scripts/tools/**": "test" },
	},
	providers: {},
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
			providers: {},
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

describe("providerSelectionSchema (§16.3–16.4 — declarative provider selection)", () => {
	test("accepts exactly the supported provider ids — the vocabulary cannot drift from the capability table", () => {
		const selectable = Object.keys(providerSelectionSchema.shape).sort();
		const supported = SUPPORTED_PROVIDERS.map((entry) => entry.providerId).sort();
		expect(selectable).toEqual(supported);
	});

	test("round-trips a jscpd request selecting one match mode", () => {
		const config = auditConfigSchema.parse({ providers: { jscpd: { mode: "normalized" } } });
		expect(config.providers.jscpd).toEqual({ mode: "normalized" });
	});

	test("round-trips requests for undelivered and gated providers — valid configuration carrying no options", () => {
		for (const providerId of ["dependency-cruiser", "knip", "sonarjs"] as const) {
			const config = auditConfigSchema.parse({ providers: { [providerId]: {} } });
			expect(config.providers[providerId]).toEqual({});
		}
	});

	test("rejects unknown provider ids actionably — an unknown request is invalid configuration", () => {
		for (const providers of [{ eslint: {} }, { sonar: {} }, { jscpd2: {} }]) {
			const parsed = auditConfigSchema.safeParse({ providers });
			expect(parsed.success).toBe(false);
			if (!parsed.success) {
				// The unknown id names itself in the message at the providers block.
				expect(parsed.error.issues[0]?.path.join(".")).toBe("providers");
				expect(parsed.error.issues[0]?.message).toContain(Object.keys(providers)[0]);
			}
		}
	});

	test("rejects malformed jscpd requests — the mode is explicit, never defaulted or configurable by command", () => {
		for (const request of [
			{},
			{ mode: "weak" },
			{ mode: "exact", minTokens: 10 },
			{ mode: "exact", command: "jscpd --min-tokens 10" },
		]) {
			expect(auditConfigSchema.safeParse({ providers: { jscpd: request } }).success).toBe(false);
		}
	});
});
