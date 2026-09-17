import { describe, expect, test } from "bun:test";
import {
	capabilityDeclarationsSchema,
	EVIDENCE_NAMESPACE,
	isNamespacedEvidenceId,
	NATIVE_NAMESPACE,
	namespacedEvidenceId,
	PRODUCER_KINDS,
	PROVIDER_STATES,
	type ProviderCapability,
	type ProviderIdentity,
	producerKindSchema,
	providerIdentitySchema,
	providerStateSchema,
} from "./provider.ts";

const nativeIdentity: ProviderIdentity = {
	kind: "native",
	id: "trellis.duplication",
	toolVersion: "0.2.1",
	adapterVersion: "0.2.1",
	mode: "shared-parse",
	options: {},
};

const externalIdentity: ProviderIdentity = {
	kind: "external",
	id: "jscpd",
	toolVersion: "5.2.1",
	adapterVersion: "0.2.1",
	mode: "token",
	options: { "ignore-identifiers": true, "max-gap-lines": 2 },
};

describe("providerStateSchema", () => {
	test("accepts exactly the five SPEC §16.2 states", () => {
		expect(PROVIDER_STATES).toEqual([
			"unrequested",
			"unavailable",
			"unsupported",
			"incomplete",
			"complete",
		]);
		for (const state of PROVIDER_STATES) {
			expect(providerStateSchema.parse(state)).toBe(state);
		}
		expect(providerStateSchema.safeParse("not-applicable").success).toBe(false);
	});
});

describe("producerKindSchema", () => {
	test("accepts native and external producers only", () => {
		expect(PRODUCER_KINDS).toEqual(["native", "external"]);
		for (const kind of PRODUCER_KINDS) {
			expect(producerKindSchema.parse(kind)).toBe(kind);
		}
		expect(producerKindSchema.safeParse("plugin").success).toBe(false);
	});
});

describe("providerIdentitySchema", () => {
	test("round-trips a native and an external identity with normalized options", () => {
		expect(providerIdentitySchema.parse(nativeIdentity)).toEqual(nativeIdentity);
		expect(providerIdentitySchema.parse(externalIdentity)).toEqual(externalIdentity);
	});

	test("rejects a native provider id outside the trellis namespace", () => {
		const result = providerIdentitySchema.safeParse({ ...nativeIdentity, id: "duplication" });
		expect(result.success).toBe(false);
	});

	test("rejects an external provider id under the reserved trellis namespace", () => {
		const result = providerIdentitySchema.safeParse({ ...externalIdentity, id: "trellis.jscpd" });
		expect(result.success).toBe(false);
	});

	test("rejects malformed versions, an empty mode, and unknown keys", () => {
		expect(
			providerIdentitySchema.safeParse({ ...externalIdentity, toolVersion: "5.2" }).success,
		).toBe(false);
		expect(
			providerIdentitySchema.safeParse({ ...externalIdentity, adapterVersion: "latest" }).success,
		).toBe(false);
		expect(providerIdentitySchema.safeParse({ ...externalIdentity, mode: "" }).success).toBe(false);
		expect(providerIdentitySchema.safeParse({ ...externalIdentity, extra: true }).success).toBe(
			false,
		);
	});

	test("rejects non-kebab option keys", () => {
		const result = providerIdentitySchema.safeParse({
			...externalIdentity,
			options: { MaxGapLines: 2 },
		});
		expect(result.success).toBe(false);
	});

	test("rejects execution-only option keys (machine paths, timestamps, durations)", () => {
		for (const key of [
			"duration-ms",
			"duration",
			"elapsed-ms",
			"timestamp",
			"started-at",
			"finished-at",
			"machine-path",
			"scratch-path",
			"exit-code",
		]) {
			const result = providerIdentitySchema.safeParse({
				...externalIdentity,
				options: { [key]: 1 },
			});
			expect(result.success).toBe(false);
		}
	});

	test("rejects non-scalar option values", () => {
		expect(
			providerIdentitySchema.safeParse({ ...externalIdentity, options: { flags: ["a"] } }).success,
		).toBe(false);
		expect(
			providerIdentitySchema.safeParse({ ...externalIdentity, options: { similarity: Number.NaN } })
				.success,
		).toBe(false);
		expect(
			providerIdentitySchema.safeParse({ ...externalIdentity, options: { note: "" } }).success,
		).toBe(false);
	});
});

describe("namespacedEvidenceId", () => {
	test("composes the reserved provider namespace and reports membership", () => {
		expect(namespacedEvidenceId("jscpd", "clone-pair")).toBe("provider.jscpd.clone-pair");
		expect(isNamespacedEvidenceId("provider.jscpd.clone-pair", "jscpd")).toBe(true);
		expect(isNamespacedEvidenceId("provider.knip.clone-pair", "jscpd")).toBe(false);
		expect(isNamespacedEvidenceId("duplication.density", "jscpd")).toBe(false);
		expect(EVIDENCE_NAMESPACE).toBe("provider");
		expect(NATIVE_NAMESPACE).toBe("trellis");
	});
});

describe("capabilityDeclarationsSchema", () => {
	test("accepts a set of distinct capability declarations", () => {
		const declarations: ProviderCapability[] = [
			{ providerId: "trellis.duplication", capabilityId: "duplication.groups" },
			{ providerId: "jscpd", capabilityId: "duplication.pairs" },
			{ providerId: "knip", capabilityId: "reachability.exports" },
		];
		expect(capabilityDeclarationsSchema.parse(declarations)).toEqual(declarations);
	});

	test("rejects a capability declared twice by the same provider", () => {
		const result = capabilityDeclarationsSchema.safeParse([
			{ providerId: "jscpd", capabilityId: "duplication.pairs" },
			{ providerId: "jscpd", capabilityId: "duplication.pairs" },
		]);
		expect(result.success).toBe(false);
	});

	test("rejects a capability declared by two different providers", () => {
		const result = capabilityDeclarationsSchema.safeParse([
			{ providerId: "jscpd", capabilityId: "duplication.pairs" },
			{ providerId: "knip", capabilityId: "duplication.pairs" },
		]);
		expect(result.success).toBe(false);
	});

	test("rejects malformed capability ids", () => {
		expect(
			capabilityDeclarationsSchema.safeParse([{ providerId: "jscpd", capabilityId: "Pairs" }])
				.success,
		).toBe(false);
	});
});
