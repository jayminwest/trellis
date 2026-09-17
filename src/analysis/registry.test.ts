import { describe, expect, test } from "bun:test";
import type { ProviderIdentity } from "../contract/index.ts";
import {
	buildNativeRegistry,
	type NativeAnalyzerRegistration,
	requiredForScoring,
	scoringCatalogMetricIds,
} from "./registry.ts";

/** A valid native identity for tests. */
const identity = (id: string): ProviderIdentity => ({
	kind: "native",
	id,
	toolVersion: "0.2.1",
	adapterVersion: "0.2.1",
	mode: "test",
	options: {},
});

/** A minimal valid registration, overridable per test. */
const entry = (
	id: string,
	overrides: Partial<NativeAnalyzerRegistration> = {},
): NativeAnalyzerRegistration => ({
	identity: identity(id),
	capabilities: [id.replace("trellis.", "")],
	metrics: [],
	requires: [],
	...overrides,
});

describe("buildNativeRegistry", () => {
	test("registers analyzers addressable by id in sorted order", () => {
		const registry = buildNativeRegistry([entry("trellis.b"), entry("trellis.a")]);
		expect(registry.analyzers.map((analyzer) => analyzer.identity.id)).toEqual([
			"trellis.a",
			"trellis.b",
		]);
		expect(registry.has("trellis.a")).toBe(true);
		expect(registry.get("trellis.a")?.identity.id).toBe("trellis.a");
		expect(registry.has("trellis.ghost")).toBe(false);
		expect(registry.get("trellis.ghost")).toBeUndefined();
	});

	test("orders prerequisites first with id-ascending ties", () => {
		const registry = buildNativeRegistry([
			entry("trellis.cycles", { requires: ["trellis.graph"] }),
			entry("trellis.alpha"),
			entry("trellis.graph", { capabilities: ["graph"], requires: ["trellis.alpha"] }),
		]);
		expect(registry.ordered().map((analyzer) => analyzer.identity.id)).toEqual([
			"trellis.alpha",
			"trellis.graph",
			"trellis.cycles",
		]);
	});

	test("rejects a duplicate analyzer id deterministically", () => {
		expect(() => buildNativeRegistry([entry("trellis.a"), entry("trellis.a")])).toThrow(
			'analyzer "trellis.a" is registered more than once',
		);
	});

	test("rejects a capability owned by two analyzers deterministically", () => {
		expect(() =>
			buildNativeRegistry([
				entry("trellis.a", { capabilities: ["shared"] }),
				entry("trellis.b", { capabilities: ["shared"] }),
			]),
		).toThrow('capability "shared" is declared by both "trellis.a" and "trellis.b"');
	});

	test("rejects a metric id owned by two analyzers deterministically", () => {
		expect(() =>
			buildNativeRegistry([
				entry("trellis.a", { metrics: ["metric.one"] }),
				entry("trellis.b", { metrics: ["metric.one"] }),
			]),
		).toThrow('metric "metric.one" is declared by both "trellis.a" and "trellis.b"');
	});

	test("rejects a prerequisite that names no registered analyzer", () => {
		expect(() =>
			buildNativeRegistry([entry("trellis.a", { requires: ["trellis.ghost"] })]),
		).toThrow('analyzer "trellis.a" requires unregistered analyzer "trellis.ghost"');
	});

	test("rejects a direct dependency cycle with a canonical path", () => {
		expect(() =>
			buildNativeRegistry([
				entry("trellis.b", { requires: ["trellis.a"] }),
				entry("trellis.a", { requires: ["trellis.b"] }),
			]),
		).toThrow('analyzer dependency cycle: "trellis.a" -> "trellis.b" -> "trellis.a"');
	});

	test("rejects a self-dependency as a one-step cycle", () => {
		expect(() => buildNativeRegistry([entry("trellis.a", { requires: ["trellis.a"] })])).toThrow(
			'analyzer dependency cycle: "trellis.a" -> "trellis.a"',
		);
	});

	test("normalizes an entered-from-outside cycle to its smallest member", () => {
		expect(() =>
			buildNativeRegistry([
				entry("trellis.x", { requires: ["trellis.z"] }),
				entry("trellis.z", { requires: ["trellis.y"] }),
				entry("trellis.y", { requires: ["trellis.z"] }),
			]),
		).toThrow('analyzer dependency cycle: "trellis.y" -> "trellis.z" -> "trellis.y"');
	});

	test("rejects an identity that violates the native namespace contract", () => {
		expect(() =>
			buildNativeRegistry([
				entry("trellis.ok"),
				{
					identity: { ...identity("foreign.tool"), kind: "native" },
					capabilities: ["foreign"],
					metrics: [],
					requires: [],
				},
			]),
		).toThrow(
			'native analyzer identity "foreign.tool" is invalid: id: a native provider id must be under the \'trellis.\' namespace',
		);
	});
});

describe("scoringCatalogMetricIds", () => {
	test("returns the current scoring formula's term ids, sorted and unique", () => {
		expect(scoringCatalogMetricIds()).toEqual([
			"duplication.density.production",
			"duplication.groups.production",
			"erosion.eroded-count.production",
			"erosion.eroded-share.production",
			"import-cycle.density",
			"import-cycle.groups",
		]);
	});
});

describe("requiredForScoring", () => {
	test("derives catalog owners plus transitive prerequisites, excluding metric-free analyzers", () => {
		const registry = buildNativeRegistry([
			entry("trellis.complexity", { metrics: ["erosion.eroded-count.production"] }),
			entry("trellis.duplication", { metrics: ["duplication.groups.production"] }),
			entry("trellis.dependency-graph", { metrics: ["graph.files"] }),
			entry("trellis.import-cycles", {
				metrics: ["import-cycle.groups"],
				requires: ["trellis.dependency-graph"],
			}),
			entry("trellis.safeguards"),
		]);
		expect(requiredForScoring(registry)).toEqual([
			"trellis.complexity",
			"trellis.dependency-graph",
			"trellis.duplication",
			"trellis.import-cycles",
		]);
	});

	test("honors an explicit catalog", () => {
		const registry = buildNativeRegistry([
			entry("trellis.a", { metrics: ["metric.a"] }),
			entry("trellis.b"),
		]);
		expect(requiredForScoring(registry, ["metric.a"])).toEqual(["trellis.a"]);
	});
});
