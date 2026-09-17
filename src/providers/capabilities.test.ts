import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { capabilityDeclarationsSchema, NATIVE_NAMESPACE } from "../contract/index.ts";
import {
	deferredDecisionSchema,
	isKnownProviderId,
	PROVIDER_SUPPORT_STATUSES,
	providerCapabilityStatus,
	providerCapabilityStatusSchema,
	SONARJS_BUG_RULE_CONTROLS,
	SONARJS_METRIC_CONTROLS,
	SUPPORTED_PROVIDERS,
	supportedCapabilityDeclarations,
} from "./capabilities.ts";

const DECISION_RECORD = resolve(import.meta.dir, "../../docs/sonarjs-decision.md");
const SPIKE_FIXTURES = resolve(
	import.meta.dir,
	"../../docs/research/sonar-provider-spike/fixtures.json",
);

/** A minimal valid entry, mutated per rejection case. */
function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		providerId: "jscpd",
		capabilityIds: ["duplication.exact"],
		unscored: true,
		status: "adapter-pending",
		requestState: "unsupported",
		reason: "contracted duplication-evidence candidate; no adapter delivered yet (plan pl-43c5)",
		...overrides,
	};
}

describe("supported provider capability metadata", () => {
	test("declares exactly the contracted external provider set (SPEC §16.1)", () => {
		expect(SUPPORTED_PROVIDERS.map((e) => e.providerId).sort()).toEqual([
			"dependency-cruiser",
			"jscpd",
			"knip",
			"sonarjs",
		]);
	});

	test("keeps capability ownership unique across providers via the contract declarations", () => {
		const declarations = supportedCapabilityDeclarations();
		expect(capabilityDeclarationsSchema.parse(declarations)).toEqual(declarations);
	});

	test("marks every provider's evidence unscored (SPEC §16.5)", () => {
		for (const provider of SUPPORTED_PROVIDERS) {
			expect(provider.unscored).toBe(true);
			expect(provider.requestState).toBe("unsupported");
		}
	});

	test("identifies known provider ids and rejects unknown ones as undefined", () => {
		for (const provider of SUPPORTED_PROVIDERS) {
			expect(isKnownProviderId(provider.providerId)).toBe(true);
			expect(providerCapabilityStatus(provider.providerId)).toBe(provider);
		}
		expect(isKnownProviderId("eslint")).toBe(false);
		expect(providerCapabilityStatus("eslint")).toBeUndefined();
	});

	test("resolves sonarjs requests to unsupported with the recorded deferral decision", () => {
		const sonar = providerCapabilityStatus("sonarjs");
		expect(sonar?.status).toBe("deferred");
		expect(sonar?.requestState).toBe("unsupported");
		expect(sonar?.decision).toEqual({
			outcome: "deferred",
			record: "docs/sonarjs-decision.md",
			issue: "trellis-db3e",
			prerequisite: "trellis-7f5d",
		});
		expect(sonar?.reason).toContain("LGPL-3.0-only");
		expect(sonar?.reason).toContain("Source-Available License v1.0");
		// The record the decision cites exists in the repository.
		expect(readFileSync(DECISION_RECORD, "utf8")).toContain("Outcome: DEFERRED");
	});

	test("preserves the six metric and six bug controls against the spike fixtures", () => {
		type Fixture = { name: string; bugRule?: string };
		const fixtures = JSON.parse(readFileSync(SPIKE_FIXTURES, "utf8")) as Fixture[];
		const metric = fixtures.filter((f) => f.bugRule === undefined);
		const bugs = fixtures.filter((f) => f.bugRule !== undefined);
		expect(metric.map((f) => f.name)).toEqual([...SONARJS_METRIC_CONTROLS]);
		expect(new Set(bugs.map((f) => f.bugRule))).toEqual(new Set([...SONARJS_BUG_RULE_CONTROLS]));
		// Six metric controls and six bug controls: three rules × positive/negative.
		expect(metric).toHaveLength(6);
		expect(bugs).toHaveLength(6);
		for (const rule of SONARJS_BUG_RULE_CONTROLS) {
			expect(bugs.filter((f) => f.bugRule === rule)).toHaveLength(2);
		}
	});

	test("rejects metadata that claims a scored capability or a delivered state", () => {
		expect(() => providerCapabilityStatusSchema.parse(entry({ unscored: false }))).toThrow(
			/unscored/,
		);
		expect(() => providerCapabilityStatusSchema.parse(entry({ requestState: "complete" }))).toThrow(
			/requestState/,
		);
		expect(() =>
			providerCapabilityStatusSchema.parse(entry({ requestState: "unavailable" })),
		).toThrow(/requestState/);
	});

	test("rejects entries using the reserved native namespace", () => {
		expect(() =>
			providerCapabilityStatusSchema.parse(
				entry({ providerId: `${NATIVE_NAMESPACE}.duplication` }),
			),
		).toThrow(/reserved 'trellis\.' namespace/);
	});

	test("couples the deferred status to a recorded decision", () => {
		expect(() => providerCapabilityStatusSchema.parse(entry({ status: "deferred" }))).toThrow(
			/must carry the recorded decision/,
		);
		const withDecision = entry({
			status: "deferred",
			decision: {
				outcome: "deferred",
				record: "docs/sonarjs-decision.md",
				issue: "trellis-db3e",
				prerequisite: "trellis-7f5d",
			},
		});
		expect(() => providerCapabilityStatusSchema.parse(withDecision)).not.toThrow();
	});

	test("forbids a decision record on adapter-pending providers", () => {
		expect(() =>
			providerCapabilityStatusSchema.parse(
				entry({
					decision: {
						outcome: "deferred",
						record: "docs/sonarjs-decision.md",
						issue: "trellis-db3e",
						prerequisite: "trellis-7f5d",
					},
				}),
			),
		).toThrow(/only a deferred provider carries a decision record/);
	});

	test("validates the deferred decision reference shape", () => {
		expect(() =>
			deferredDecisionSchema.parse({
				outcome: "cleared",
				record: "docs/sonarjs-decision.md",
				issue: "trellis-db3e",
				prerequisite: "trellis-7f5d",
			}),
		).toThrow(/outcome/);
		expect(() =>
			deferredDecisionSchema.parse({
				outcome: "deferred",
				record: "/absolute/sonarjs-decision.md",
				issue: "trellis-db3e",
				prerequisite: "trellis-7f5d",
			}),
		).toThrow(/record/);
		expect(() =>
			deferredDecisionSchema.parse({
				outcome: "deferred",
				record: "src/capabilities.ts",
				issue: "trellis-db3e",
				prerequisite: "trellis-7f5d",
			}),
		).toThrow(/under docs/);
		expect(() =>
			deferredDecisionSchema.parse({
				outcome: "deferred",
				record: "docs/sonarjs-decision.md",
				issue: "not-a-seeds-id",
				prerequisite: "trellis-7f5d",
			}),
		).toThrow(/seeds tracker id/);
	});

	test("exposes only the two undelivered support statuses", () => {
		expect([...PROVIDER_SUPPORT_STATUSES]).toEqual(["adapter-pending", "deferred"]);
	});
});
