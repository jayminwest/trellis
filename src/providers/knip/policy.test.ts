import { describe, expect, test } from "bun:test";
import { producerSemanticsDifferences } from "../../compare/evidence.ts";
import type {
	AnalysisIdentity,
	KnipProviderRequest,
	ProviderIdentity,
} from "../../contract/index.ts";
import { measurementIdentity } from "../../contract/index.ts";
import { compileReachabilityPolicy } from "./policy.ts";

/** The AC5 domain controls: a script entry, a barrel public surface and a named export. */
const declaredContext: KnipProviderRequest = {
	entries: ["scripts/check-all.ts", "src/cli/main.ts"],
	public: [{ path: "src/client/index.ts", export: "audit" }, { path: "src/index.ts" }],
	tests: "roots",
};

/** A minimal valid analysis identity — the unchanged measurement side of the producer pair. */
const analysis: AnalysisIdentity = {
	selection: { sourceSets: ["production"], files: [] },
	parser: { engine: "knip.typescript", version: "5.9.3" },
	options: {},
};

/** A knip provider identity carrying the compiled policy's identity options. */
function policyProvider(
	options: ReturnType<typeof compileReachabilityPolicy>["identityOptions"],
): ProviderIdentity {
	return {
		kind: "external",
		id: "knip",
		toolVersion: "6.16.1",
		adapterVersion: "0.1.0",
		mode: "contextual-reachability",
		options,
	};
}

describe("compileReachabilityPolicy (trellis-5da5 — pure context compilation)", () => {
	test("compiles the declared context in canonical order with a stable digest", () => {
		const policy = compileReachabilityPolicy(declaredContext);
		expect(policy.entries).toEqual(["scripts/check-all.ts", "src/cli/main.ts"]);
		expect(policy.publicSurfaces).toEqual([
			{ path: "src/client/index.ts", export: "audit" },
			{ path: "src/index.ts" },
		]);
		expect(policy.testMode).toBe("roots");
		expect(policy.pluginDiscovery).toBe("disabled");
		expect(policy.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(compileReachabilityPolicy(declaredContext)).toEqual(policy);
	});

	test("normalizes declaration order — the same roots in any order are one identity", () => {
		const declared = compileReachabilityPolicy(declaredContext);
		const reversed = compileReachabilityPolicy({
			entries: [...(declaredContext.entries ?? [])].reverse(),
			public: [...(declaredContext.public ?? [])].reverse(),
			tests: "roots",
		});
		expect(reversed.digest).toBe(declared.digest);
		expect(reversed.canonical).toBe(declared.canonical);
		expect(reversed.identityOptions).toEqual(declared.identityOptions);
	});

	test("records an absent declaration explicitly — absence is assumption, never a clean result", () => {
		const empty = compileReachabilityPolicy({});
		const declaredEmptyLists = compileReachabilityPolicy({ entries: [], public: [] });
		expect(empty.entries).toEqual([]);
		expect(empty.publicSurfaces).toEqual([]);
		expect(empty.testMode).toBe("excluded");
		expect(empty.digest).toBe(declaredEmptyLists.digest);
		expect(empty.identityOptions["reachability-entry-count"]).toBe(0);
		expect(empty.identityOptions["reachability-public-surface-count"]).toBe(0);
		expect(empty.identityOptions["reachability-test-mode"]).toBe("excluded");
		expect(empty.identityOptions["reachability-policy-digest"]).toBe(`sha256:${empty.digest}`);
		const ids = empty.assumptions.map((entry) => entry.id);
		expect(ids).toContain("no-entries-declared");
		expect(ids).toContain("no-public-surfaces-declared");
		expect(ids).toContain("plugin-discovery-disabled");
		// Absence is visible identity, distinct from every declared context —
		// and can never be read as confirmed-dead-code coverage.
		expect(empty.digest).not.toBe(compileReachabilityPolicy(declaredContext).digest);
		expect(empty.digest).not.toBe(compileReachabilityPolicy({ entries: ["src/main.ts"] }).digest);
	});

	test("keeps a declared context's assumptions free of absence records it does not have", () => {
		const policy = compileReachabilityPolicy(declaredContext);
		const ids = policy.assumptions.map((entry) => entry.id);
		expect(ids).toEqual(["plugin-discovery-disabled"]);
	});

	test("distinguishes test participation in normalized identity", () => {
		const excluded = compileReachabilityPolicy({ tests: "excluded" });
		const roots = compileReachabilityPolicy({ tests: "roots" });
		expect(excluded.digest).not.toBe(roots.digest);
		expect(excluded.identityOptions["reachability-test-mode"]).toBe("excluded");
		expect(roots.identityOptions["reachability-test-mode"]).toBe("roots");
		expect(
			new Set([excluded.digest, roots.digest, compileReachabilityPolicy({}).digest]).size,
		).toBe(2);
	});

	test("carries the declaration bounds it was validated under", () => {
		const policy = compileReachabilityPolicy(declaredContext);
		expect(policy.version).toBe(1);
		expect(policy.bounds).toEqual({
			maxEntryFiles: 64,
			maxPublicSurfaces: 64,
			maxPathLength: 256,
			maxExportNameLength: 64,
		});
		expect(policy.identityOptions["reachability-policy-version"]).toBe(1);
		expect(policy.identityOptions["reachability-entry-count"]).toBe(2);
		expect(policy.identityOptions["reachability-public-surface-count"]).toBe(2);
	});

	test("re-validates its input — non-schema data throws actionably, never compiles", () => {
		expect(() =>
			compileReachabilityPolicy({
				entries: ["src/main.ts", "src/main.ts"],
			} as unknown as KnipProviderRequest),
		).toThrow();
		expect(() =>
			compileReachabilityPolicy({ vite: true } as unknown as KnipProviderRequest),
		).toThrow();
	});
});

describe("reachability policy identity in step-6 analysis compatibility (trellis-5da5 AC3)", () => {
	test("rides the provider-options seam — an unchanged declaration is an unchanged measurement", () => {
		const policy = compileReachabilityPolicy(declaredContext);
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

	test("a changed declared reachability context is a changed measurement — noncomparable, never churn", () => {
		const baseline = compileReachabilityPolicy(declaredContext);
		const current = compileReachabilityPolicy({
			...declaredContext,
			entries: [...(declaredContext.entries ?? []), "src/index.ts"],
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

	test("a changed test-participation mode alone changes the normalized identity", () => {
		const baseline = compileReachabilityPolicy({ tests: "excluded" });
		const current = compileReachabilityPolicy({ tests: "roots" });
		expect(
			producerSemanticsDifferences(
				{ provider: policyProvider(baseline.identityOptions), analysis },
				{ provider: policyProvider(current.identityOptions), analysis },
			).map((difference) => difference.code),
		).toEqual(["provider-identity"]);
	});
});
