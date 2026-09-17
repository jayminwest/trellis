import { describe, expect, test } from "bun:test";
import {
	ARCHITECTURE_POLICY_VERSION,
	architectureRuleSchema,
	DEPENDENCY_EDGE_KINDS,
	dependencyCruiserProviderRequestSchema,
	MAX_ARCHITECTURE_PATTERN_LENGTH,
	MAX_ARCHITECTURE_RULES,
} from "./architecture-policy.ts";

/** The AC5 positive controls: an allowed domain→shared exception and a forbidden domain→UI boundary. */
const domainBoundaryRules = [
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
] as const;

describe("dependencyCruiserProviderRequestSchema (trellis-89be — declarative rule subset)", () => {
	test("accepts an absent rules block — absence declares nothing, never coherence", () => {
		expect(dependencyCruiserProviderRequestSchema.parse({})).toEqual({});
		expect(dependencyCruiserProviderRequestSchema.parse({ rules: [] })).toEqual({ rules: [] });
	});

	test("compiles allowed domain/shared and forbidden domain/UI boundary controls as data", () => {
		const parsed = dependencyCruiserProviderRequestSchema.parse({
			rules: domainBoundaryRules,
		});
		expect(parsed.rules?.length).toBe(2);
		expect(parsed.rules?.[1]).toEqual({
			kind: "boundary",
			name: "domain-must-not-import-ui",
			allowance: "forbidden",
			edges: ["runtime", "type-only"],
			from: { path: "^src/domain/" },
			to: { path: "^src/ui/" },
		});
	});

	test("accepts cycle rules that distinguish type-only from runtime edge policies", () => {
		const parsed = dependencyCruiserProviderRequestSchema.parse({
			rules: [
				{ kind: "cycle", name: "no-runtime-cycles", edges: ["runtime"] },
				{ kind: "cycle", name: "no-type-only-cycles", edges: ["type-only"] },
				{ kind: "cycle", name: "no-cycles-at-all", edges: ["runtime", "type-only"] },
				{ kind: "unresolved", name: "no-unresolved" },
			],
		});
		expect(parsed.rules?.length).toBe(4);
	});

	test("accepts every declared edge kind over both cycle flavors", () => {
		for (const edges of [["runtime"], ["type-only"], ["runtime", "type-only"]]) {
			expect(
				architectureRuleSchema.safeParse({ kind: "cycle", name: "cycle-rule", edges }).success,
			).toBe(true);
		}
		expect(DEPENDENCY_EDGE_KINDS).toEqual(["runtime", "type-only"]);
		expect(ARCHITECTURE_POLICY_VERSION).toBe(1);
	});

	test("rejects unknown rule kinds and unknown keys actionably", () => {
		for (const rule of [
			{ kind: "layering", name: "layers", from: { path: "^src/" }, to: { path: "^src/" } },
			{ kind: "boundary", name: "b", allowance: "forbidden", severity: "error" },
			{ kind: "cycle", name: "c", edges: ["runtime"], path: "^src/" },
			{ kind: "unresolved", name: "u", module: true },
		]) {
			expect(architectureRuleSchema.safeParse(rule).success).toBe(false);
		}
	});

	test("rejects executable rule files and command-bearing requests — inline data only", () => {
		for (const request of [
			{ rules: ".dependency-cruiser.cjs" },
			{ config: ".dependency-cruiser.json" },
			{
				rules: [
					{
						kind: "boundary",
						name: "from-file",
						allowance: "forbidden",
						edges: ["runtime"],
						from: { path: "^src/" },
						to: { path: "^src/" },
						file: ".dependency-cruiser.cjs",
					},
				],
			},
			{ rules: [{ kind: "unresolved", name: "u", command: "node .dependency-cruiser.cjs" }] },
		]) {
			expect(dependencyCruiserProviderRequestSchema.safeParse(request).success).toBe(false);
		}
	});

	test("rejects a pasted executable dependency-cruiser config — the raw tool shape is not the subset", () => {
		// The research fixture's dependency-cruiser block (docs/research/
		// architecture-provider-spike/fixture-config.json): `forbidden`
		// sections, `severity`, empty `from`, `to.circular`, `options`.
		const rawDependencyCruiserConfig = {
			forbidden: [
				{ name: "no-cycles", severity: "error", from: {}, to: { circular: true } },
				{ name: "no-unresolved", severity: "error", from: {}, to: { couldNotResolve: true } },
				{
					name: "domain-must-not-import-ui",
					severity: "error",
					from: { path: "^src/domain/" },
					to: { path: "^src/ui/" },
				},
			],
			options: { doNotFollow: { path: "node_modules" }, tsPreCompilationDeps: true },
		};
		expect(
			dependencyCruiserProviderRequestSchema.safeParse(rawDependencyCruiserConfig).success,
		).toBe(false);
	});

	test("rejects unknown scope-selector vocabulary — selectors are exactly a path pattern", () => {
		for (const selector of [{ path: "^src/", orphan: true }, { circular: true }, {}]) {
			expect(
				architectureRuleSchema.safeParse({
					kind: "boundary",
					name: "b",
					allowance: "forbidden",
					edges: ["runtime"],
					from: selector,
					to: { path: "^src/" },
				}).success,
			).toBe(false);
		}
	});

	test("rejects unanchored, absolute, traversal and uncompileable patterns", () => {
		for (const path of [
			"src/domain/", // unanchored — ambiguous at any depth
			"^/src/domain/", // absolute
			"^src/../domain/", // traversal
			"^src/(", // uncompileable
			"^", // nothing to select
			"x", // not anchored at all
		]) {
			expect(
				architectureRuleSchema.safeParse({
					kind: "boundary",
					name: "b",
					allowance: "forbidden",
					edges: ["runtime"],
					from: { path },
					to: { path: "^src/" },
				}).success,
			).toBe(false);
		}
	});

	test("rejects patterns beyond the length bound and rule sets beyond the count bound", () => {
		const overlongPattern = `^src/${"a".repeat(MAX_ARCHITECTURE_PATTERN_LENGTH)}/`;
		expect(
			architectureRuleSchema.safeParse({
				kind: "boundary",
				name: "b",
				allowance: "forbidden",
				edges: ["runtime"],
				from: { path: overlongPattern },
				to: { path: "^src/" },
			}).success,
		).toBe(false);
		const rules = Array.from({ length: MAX_ARCHITECTURE_RULES + 1 }, (_, index) => ({
			kind: "boundary",
			name: `forbid-layer-${index}`,
			allowance: "forbidden",
			edges: ["runtime"],
			from: { path: "^src/domain/" },
			to: { path: `^src/layer-${index}/` },
		}));
		expect(dependencyCruiserProviderRequestSchema.safeParse({ rules }).success).toBe(false);
		expect(
			dependencyCruiserProviderRequestSchema.safeParse({ rules: rules.slice(0, -1) }).success,
		).toBe(true);
	});

	test("rejects ambiguous rule sets — duplicate names", () => {
		const parsed = dependencyCruiserProviderRequestSchema.safeParse({
			rules: [
				{ kind: "unresolved", name: "no-unresolved" },
				{ kind: "unresolved", name: "no-unresolved" },
			],
		});
		expect(parsed.success).toBe(false);
		if (!parsed.success) {
			expect(parsed.error.issues[0]?.message).toContain('"no-unresolved" is declared twice');
		}
	});

	test("rejects duplicate rule semantics under different names", () => {
		for (const rules of [
			[
				{ kind: "unresolved", name: "no-unresolved" },
				{ kind: "unresolved", name: "no-unresolved-again" },
			],
			[
				{ kind: "cycle", name: "no-cycles", edges: ["runtime"] },
				{ kind: "cycle", name: "no-cycles-alias", edges: ["runtime"] },
			],
			[
				{ ...domainBoundaryRules[1] },
				{
					kind: "boundary",
					name: "domain-ui-alias",
					allowance: "forbidden",
					edges: ["runtime", "type-only"],
					from: { path: "^src/domain/" },
					to: { path: "^src/ui/" },
				},
			],
		]) {
			expect(dependencyCruiserProviderRequestSchema.safeParse({ rules }).success).toBe(false);
		}
	});

	test("rejects a forbidden/allowed pair over identical selectors and edge kinds", () => {
		const parsed = dependencyCruiserProviderRequestSchema.safeParse({
			rules: [
				{
					kind: "boundary",
					name: "forbid-domain-ui",
					allowance: "forbidden",
					edges: ["runtime"],
					from: { path: "^src/domain/" },
					to: { path: "^src/ui/" },
				},
				{
					kind: "boundary",
					name: "allow-domain-ui",
					allowance: "allowed",
					edges: ["runtime"],
					from: { path: "^src/domain/" },
					to: { path: "^src/ui/" },
				},
			],
		});
		expect(parsed.success).toBe(false);
		if (!parsed.success) {
			expect(parsed.error.issues[0]?.message).toContain("cannot be both forbidden and allowed");
		}
	});

	test("keeps distinct-edge rules over the same selectors independent — no false contradiction", () => {
		expect(
			dependencyCruiserProviderRequestSchema.safeParse({
				rules: [
					{
						kind: "boundary",
						name: "forbid-runtime-domain-ui",
						allowance: "forbidden",
						edges: ["runtime"],
						from: { path: "^src/domain/" },
						to: { path: "^src/ui/" },
					},
					{
						kind: "boundary",
						name: "allow-type-only-domain-ui",
						allowance: "allowed",
						edges: ["type-only"],
						from: { path: "^src/domain/" },
						to: { path: "^src/ui/" },
					},
				],
			}).success,
		).toBe(true);
	});

	test("rejects empty, unsorted or duplicated edge-kind lists", () => {
		for (const edges of [[], ["type-only", "runtime"], ["runtime", "runtime"], ["types"]]) {
			expect(architectureRuleSchema.safeParse({ kind: "cycle", name: "c", edges }).success).toBe(
				false,
			);
		}
	});

	test("rejects malformed rule names", () => {
		for (const name of ["", "No-Cycles", "no_cycles", "noCycles", "3-cycles", "cycles."]) {
			expect(architectureRuleSchema.safeParse({ kind: "unresolved", name }).success).toBe(false);
		}
	});
});
