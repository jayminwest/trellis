import { describe, expect, test } from "bun:test";
import { producerSemanticsDifferences } from "../../compare/evidence.ts";
import type {
	AnalysisIdentity,
	DependencyCruiserProviderRequest,
	ProviderIdentity,
} from "../../contract/index.ts";
import { measurementIdentity } from "../../contract/index.ts";
import { compileArchitecturePolicy } from "./policy.ts";

/** The AC5 domain controls: an allowed domain→shared exception, a forbidden domain→UI boundary. */
const domainPolicy: DependencyCruiserProviderRequest = {
	rules: [
		{
			kind: "boundary",
			name: "domain-may-import-shared",
			allowance: "allowed",
			edges: ["runtime"],
			from: { path: "^src/domain/" },
			to: { path: "^src/shared/" },
		},
		{
			kind: "boundary",
			name: "domain-must-not-import-ui",
			allowance: "forbidden",
			edges: ["runtime", "type-only"],
			from: { path: "^src/domain/" },
			to: { path: "^src/ui/" },
		},
	],
};

const cyclePolicy = (edges: ("runtime" | "type-only")[]): DependencyCruiserProviderRequest => ({
	rules: [{ kind: "cycle", name: "no-cycles", edges }],
});

/** A minimal valid analysis identity — the unchanged measurement side of the producer pair. */
const analysis: AnalysisIdentity = {
	selection: { sourceSets: ["production"], files: [] },
	parser: { engine: "dependency-cruiser.typescript", version: "5.9.3" },
	options: {},
};

/** A dependency-cruiser provider identity carrying the compiled policy's identity options. */
function policyProvider(
	options: ReturnType<typeof compileArchitecturePolicy>["identityOptions"],
): ProviderIdentity {
	return {
		kind: "external",
		id: "dependency-cruiser",
		toolVersion: "17.3.8",
		adapterVersion: "0.1.0",
		mode: "architecture-rules",
		options,
	};
}

describe("compileArchitecturePolicy (trellis-89be — pure rule compilation)", () => {
	test("compiles the domain controls in deterministic name order with a stable digest", () => {
		const policy = compileArchitecturePolicy(domainPolicy);
		expect(policy.ruleCount).toBe(2);
		expect(policy.rules.map((rule) => rule.name)).toEqual([
			"domain-may-import-shared",
			"domain-must-not-import-ui",
		]);
		expect(policy.rules[0]).toEqual({
			kind: "boundary",
			name: "domain-may-import-shared",
			allowance: "allowed",
			edges: ["runtime"],
			from: "^src/domain/",
			to: "^src/shared/",
		});
		expect(policy.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(compileArchitecturePolicy(domainPolicy)).toEqual(policy);
	});

	test("normalizes declaration order — the same rules in any order are one policy identity", () => {
		const declared = compileArchitecturePolicy(domainPolicy);
		const reversed = compileArchitecturePolicy({
			rules: [...(domainPolicy.rules ?? [])].reverse(),
		});
		expect(reversed.digest).toBe(declared.digest);
		expect(reversed.canonical).toBe(declared.canonical);
		expect(reversed.identityOptions).toEqual(declared.identityOptions);
	});

	test("records zero rules explicitly — absence is visible identity, never inferred coherence", () => {
		const empty = compileArchitecturePolicy({});
		const declaredEmpty = compileArchitecturePolicy({ rules: [] });
		expect(empty.ruleCount).toBe(0);
		expect(empty.rules).toEqual([]);
		expect(empty.digest).toBe(declaredEmpty.digest);
		expect(empty.identityOptions["architecture-rule-count"]).toBe(0);
		expect(empty.identityOptions["architecture-policy-digest"]).toBe(`sha256:${empty.digest}`);
		// Nothing is inferred from directory names: an empty request compiles
		// to zero rules, and its identity is distinct from every rule-bearing
		// policy — absence can never be read as architectural coherence.
		expect(empty.digest).not.toBe(compileArchitecturePolicy(domainPolicy).digest);
		expect(empty.digest).not.toBe(compileArchitecturePolicy(cyclePolicy(["runtime"])).digest);
	});

	test("distinguishes type-only from runtime cycle policies in normalized identity", () => {
		const runtime = compileArchitecturePolicy(cyclePolicy(["runtime"]));
		const typeOnly = compileArchitecturePolicy(cyclePolicy(["type-only"]));
		const both = compileArchitecturePolicy(cyclePolicy(["runtime", "type-only"]));
		expect(new Set([runtime.digest, typeOnly.digest, both.digest]).size).toBe(3);
		expect(runtime.rules[0]).toEqual({ kind: "cycle", name: "no-cycles", edges: ["runtime"] });
		expect(typeOnly.rules[0]).toEqual({
			kind: "cycle",
			name: "no-cycles",
			edges: ["type-only"],
		});
		expect(runtime.identityOptions["architecture-policy-digest"]).not.toBe(
			typeOnly.identityOptions["architecture-policy-digest"],
		);
	});

	test("carries the evaluation bounds it was validated under", () => {
		const policy = compileArchitecturePolicy(domainPolicy);
		expect(policy.version).toBe(1);
		expect(policy.bounds).toEqual({
			maxRules: 32,
			maxPatternLength: 256,
			maxRuleNameLength: 64,
		});
		expect(policy.identityOptions["architecture-policy-version"]).toBe(1);
		expect(policy.identityOptions["architecture-rule-count"]).toBe(2);
	});

	test("re-validates its input — non-schema data throws actionably, never compiles", () => {
		expect(() =>
			compileArchitecturePolicy({
				rules: [{ kind: "layering", name: "layers" }],
			} as unknown as DependencyCruiserProviderRequest),
		).toThrow();
		expect(() =>
			compileArchitecturePolicy({
				rules: [
					{ kind: "boundary", name: "b", allowance: "forbidden", file: ".dependency-cruiser.cjs" },
				],
			} as unknown as DependencyCruiserProviderRequest),
		).toThrow();
	});
});

describe("architecture policy identity in step-6 analysis compatibility (trellis-89be AC3)", () => {
	test("rides the provider-options seam — an unchanged policy is an unchanged measurement", () => {
		const policy = compileArchitecturePolicy(domainPolicy);
		expect(
			producerSemanticsDifferences(
				{ provider: policyProvider(policy.identityOptions), analysis },
				{ provider: policyProvider(policy.identityOptions), analysis },
			),
		).toEqual([]);
		expect(measurementIdentity(policyProvider(policy.identityOptions), analysis)).toBe(
			measurementIdentity(policyProvider(policy.identityOptions), analysis),
		);
	});

	test("a changed declared architecture is a changed measurement — noncomparable, never finding churn", () => {
		const baseline = compileArchitecturePolicy(domainPolicy);
		const current = compileArchitecturePolicy({
			rules: [
				...(domainPolicy.rules ?? []),
				{ kind: "cycle", name: "no-cycles", edges: ["runtime"] },
			],
		});
		const differences = producerSemanticsDifferences(
			{ provider: policyProvider(baseline.identityOptions), analysis },
			{ provider: policyProvider(current.identityOptions), analysis },
		);
		expect(differences.map((difference) => difference.code)).toEqual(["provider-identity"]);
		expect(differences[0]?.message).toContain("provider identity differs");
		expect(measurementIdentity(policyProvider(baseline.identityOptions), analysis)).not.toBe(
			measurementIdentity(policyProvider(current.identityOptions), analysis),
		);
	});

	test("a changed selector alone changes the normalized policy identity", () => {
		const baseline = compileArchitecturePolicy(domainPolicy);
		const current = compileArchitecturePolicy({
			rules: [
				{
					kind: "boundary",
					name: "domain-may-import-shared",
					allowance: "allowed",
					edges: ["runtime"],
					from: { path: "^src/domain/" },
					to: { path: "^src/support/" },
				},
				...(domainPolicy.rules ?? []).slice(1),
			],
		});
		expect(
			producerSemanticsDifferences(
				{ provider: policyProvider(baseline.identityOptions), analysis },
				{ provider: policyProvider(current.identityOptions), analysis },
			).map((difference) => difference.code),
		).toEqual(["provider-identity"]);
	});
});
