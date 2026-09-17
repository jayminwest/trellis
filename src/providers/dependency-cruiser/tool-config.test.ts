/**
 * Generated tool-configuration tests (plan `pl-43c5` step 22 —
 * trellis-adbf): the compiled declarative policy maps deterministically
 * onto the tool's own rule vocabulary — forbidden boundaries with edge
 * filters, cycle rules with runtime/type-only separation, unresolved
 * scoped to local specifiers — and `allowed` boundaries never generate
 * tool rules (the exception is declarative policy, applied in
 * normalization). The owned tsconfig and argv are generated, never read
 * from the target.
 */
import { describe, expect, test } from "bun:test";
import type { DependencyCruiserProviderRequest } from "../../contract/index.ts";
import { compileArchitecturePolicy } from "./policy.ts";
import {
	dependencyCruiserInvocationArgs,
	dependencyCruiserToolConfig,
	dependencyCruiserTsConfig,
	edgeKindFilter,
	generatedRuleNames,
} from "./tool-config.ts";

/** Compile one request (fails fast on an invalid one). */
function policyOf(request: DependencyCruiserProviderRequest) {
	return compileArchitecturePolicy(request);
}

describe("edgeKindFilter", () => {
	test("maps each declared edge-kind set onto the tool's dependency-type filters", () => {
		expect(edgeKindFilter(["type-only"])).toEqual({ dependencyTypes: ["type-only"] });
		expect(edgeKindFilter(["runtime"])).toEqual({ dependencyTypesNot: ["type-only"] });
		expect(edgeKindFilter(["runtime", "type-only"])).toEqual({});
	});
});

describe("dependencyCruiserToolConfig", () => {
	test("generates one forbidden rule per forbidden boundary, cycle and unresolved rule with pinned options", () => {
		const config = dependencyCruiserToolConfig(
			policyOf({
				rules: [
					{
						kind: "boundary",
						name: "domain-must-not-import-ui",
						allowance: "forbidden",
						edges: ["runtime"],
						from: { path: "^src/domain/" },
						to: { path: "^src/ui/" },
					},
					{ kind: "cycle", name: "no-type-only-cycles", edges: ["type-only"] },
					{ kind: "unresolved", name: "no-unresolved-imports" },
				],
			}),
			{ tsConfigPath: "/owned/tsconfig.json" },
		);
		expect(config.forbidden).toEqual([
			{
				severity: "error",
				name: "domain-must-not-import-ui",
				from: { path: "^src/domain/" },
				to: { path: "^src/ui/", dependencyTypesNot: ["type-only"] },
			},
			{
				severity: "error",
				name: "no-type-only-cycles",
				from: {},
				to: { circular: true, dependencyTypes: ["type-only"] },
			},
			{
				severity: "error",
				name: "no-unresolved-imports",
				from: {},
				to: { couldNotResolve: true, pathNot: "^[A-Za-z@]" },
			},
		]);
		expect(config.options).toEqual({
			doNotFollow: { path: "node_modules" },
			tsPreCompilationDeps: true,
			tsConfig: { fileName: "/owned/tsconfig.json" },
			enhancedResolveOptions: {
				extensions: [".ts", ".tsx", ".js", ".json"],
				conditionNames: ["import", "require", "node", "default"],
			},
		});
	});

	test("never generates a tool rule for an allowed boundary or the tool's own allowed section", () => {
		const config = dependencyCruiserToolConfig(
			policyOf({
				rules: [
					{
						kind: "boundary",
						name: "allow-domain-shared",
						allowance: "allowed",
						edges: ["runtime"],
						from: { path: "^src/domain/" },
						to: { path: "^src/shared/" },
					},
				],
			}),
			{ tsConfigPath: "/owned/tsconfig.json" },
		);
		expect(config.forbidden).toEqual([]);
		expect(config).not.toHaveProperty("allowed");
		expect(config).not.toHaveProperty("allowedSeverity");
	});

	test("scopes the unresolved rule to local specifiers, so externals stay stubs never violations", () => {
		const config = dependencyCruiserToolConfig(
			policyOf({ rules: [{ kind: "unresolved", name: "no-unresolved" }] }),
			{ tsConfigPath: "/owned/tsconfig.json" },
		);
		const rule = config.forbidden[0] as { to: { pathNot: string } };
		expect(rule.to.pathNot).toBe("^[A-Za-z@]");
	});

	test("is deterministic: the same policy generates the identical configuration", () => {
		const request: DependencyCruiserProviderRequest = {
			rules: [
				{ kind: "cycle", name: "no-cycles", edges: ["runtime"] },
				{ kind: "unresolved", name: "no-unresolved" },
			],
		};
		expect(dependencyCruiserToolConfig(policyOf(request), { tsConfigPath: "/x" })).toEqual(
			dependencyCruiserToolConfig(policyOf(request), { tsConfigPath: "/x" }),
		);
	});
});

describe("generatedRuleNames", () => {
	test("carries every forbidden boundary, cycle and unresolved rule — never an allowed boundary", () => {
		const names = generatedRuleNames(
			policyOf({
				rules: [
					{
						kind: "boundary",
						name: "forbidden-one",
						allowance: "forbidden",
						edges: ["runtime"],
						from: { path: "^a/" },
						to: { path: "^b/" },
					},
					{
						kind: "boundary",
						name: "allowed-one",
						allowance: "allowed",
						edges: ["runtime"],
						from: { path: "^c/" },
						to: { path: "^d/" },
					},
					{ kind: "cycle", name: "no-cycles", edges: ["runtime"] },
					{ kind: "unresolved", name: "no-unresolved" },
				],
			}),
		);
		expect(names).toEqual(new Set(["forbidden-one", "no-cycles", "no-unresolved"]));
	});
});

describe("dependencyCruiserTsConfig", () => {
	test("generates the owned minimal tsconfig pointing at the staged source tree", () => {
		const parsed = JSON.parse(dependencyCruiserTsConfig()) as {
			compilerOptions: Record<string, unknown>;
			include: string[];
		};
		expect(parsed.compilerOptions).toEqual({
			module: "ESNext",
			moduleResolution: "Bundler",
			allowImportingTsExtensions: true,
			noEmit: true,
		});
		expect(parsed.include).toEqual(["../source/**/*"]);
	});
});

describe("dependencyCruiserInvocationArgs", () => {
	test("passes the owned generated config, JSON output and the staged scope — nothing target-directed", () => {
		expect(dependencyCruiserInvocationArgs("/owned/cruise.json")).toEqual([
			"--config",
			"/owned/cruise.json",
			"--output-type",
			"json",
			".",
		]);
	});
});
