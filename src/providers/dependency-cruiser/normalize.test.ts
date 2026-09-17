/**
 * Normalization tests (plan `pl-43c5` step 22 — trellis-adbf): validated
 * raw observations become stable, namespaced, unscored evidence — one
 * finding per violation with its edge flavors and cycle path preserved,
 * allowed-boundary exemptions as visible evidence, stubs and edges kept
 * separate from production nodes, zero rules never reading as coherence,
 * and deterministic output over reordered reports.
 */
import { describe, expect, test } from "bun:test";
import type { DependencyCruiserProviderRequest } from "../../contract/index.ts";
import type { CruiseCoverage } from "./cruise-run.ts";
import {
	InvalidDependencyCruiserEvidenceError,
	normalizeDependencyCruiserReport,
} from "./normalize.ts";
import { compileArchitecturePolicy } from "./policy.ts";
import type { RawDependencyCruiserReport } from "./raw.ts";

/** The declarative policy the normalization tests evaluate. */
const REQUEST: DependencyCruiserProviderRequest = {
	rules: [
		{ kind: "cycle", name: "no-runtime-cycles", edges: ["runtime"] },
		{ kind: "cycle", name: "no-type-only-cycles", edges: ["type-only"] },
		{
			kind: "boundary",
			name: "domain-must-not-import-ui",
			allowance: "forbidden",
			edges: ["runtime"],
			from: { path: "^src/domain/" },
			to: { path: "^src/ui/" },
		},
		{
			kind: "boundary",
			name: "allow-domain-shared",
			allowance: "allowed",
			edges: ["runtime"],
			from: { path: "^src/domain/" },
			to: { path: "^src/shared/" },
		},
		{ kind: "unresolved", name: "no-unresolved-imports" },
	],
};

/** A full-coverage account over the selection. */
function fullCoverage(): CruiseCoverage {
	return {
		selectedFiles: 3,
		representedFiles: ["src/domain/bad.ts", "src/main.ts", "src/ui/view.ts"],
		missingFiles: [],
		stubs: [{ source: "zod", kind: "external" }],
		totalCruised: 4,
	};
}

/** One raw report builder over the three-module selection. */
function rawReport(
	violations: unknown[],
	extraModules: unknown[] = [],
): RawDependencyCruiserReport {
	const module = (source: string, dependencies: unknown[] = []) => ({
		source,
		dependencies,
		dependents: [],
		orphan: false,
		valid: true,
	});
	const dependency = (over: Record<string, unknown>) => ({
		module: "./x.ts",
		resolved: "src/x.ts",
		moduleSystem: "es6",
		dependencyTypes: ["local", "import"],
		dynamic: false,
		coreModule: false,
		followable: true,
		couldNotResolve: false,
		matchesDoNotFollow: false,
		exoticallyRequired: false,
		circular: false,
		valid: true,
		...over,
	});
	return {
		modules: [
			module("src/domain/bad.ts", [
				dependency({
					resolved: "src/ui/view.ts",
					dependencyTypes: ["local", "type-only", "import"],
				}),
			]),
			module("src/main.ts", [
				dependency({ resolved: "src/domain/bad.ts" }),
				dependency({ dynamic: true, resolved: "src/ui/view.ts" }),
			]),
			module("src/ui/view.ts"),
			...extraModules,
		],
		summary: {
			violations: violations as never[],
			error: violations.length,
			warn: 0,
			info: 0,
			ignore: 0,
			totalCruised: 4,
			totalDependenciesCruised: 3,
		},
	} as RawDependencyCruiserReport;
}

/** The selection paths the normalization accounts. */
const SELECTION = ["src/domain/bad.ts", "src/main.ts", "src/ui/view.ts"];

/** Normalize a report under the test policy. */
function normalize(report: RawDependencyCruiserReport, coverage = fullCoverage()) {
	return normalizeDependencyCruiserReport(
		report,
		compileArchitecturePolicy(REQUEST),
		coverage,
		SELECTION,
	);
}

/** One raw violation builder. */
function violation(over: Record<string, unknown>) {
	return {
		type: "dependency",
		rule: { severity: "error", name: "domain-must-not-import-ui" },
		from: "src/domain/bad.ts",
		to: "src/ui/view.ts",
		unresolvedTo: "../ui/view.ts",
		dependencyTypes: ["local", "import"],
		...over,
	};
}

describe("normalizeDependencyCruiserReport", () => {
	test("shapes each violation as one namespaced finding with preserved path, specifier and edge flavors", () => {
		const evidence = normalize(
			rawReport([
				violation({
					rule: { severity: "error", name: "no-runtime-cycles" },
					type: "cycle",
					to: "src/main.ts",
				}),
			]),
		);
		expect(evidence.violations).toEqual([
			{
				rule: "no-runtime-cycles",
				type: "cycle",
				from: "src/domain/bad.ts",
				to: "src/main.ts",
				specifier: "../ui/view.ts",
				edges: ["runtime"],
				cycle: [],
			},
		]);
		expect(evidence.findings).toHaveLength(1);
		expect(evidence.findings[0]).toEqual({
			kind: "provider.dependency-cruiser.no-runtime-cycles",
			path: "src/domain/bad.ts",
			range: { start: { line: 1 }, end: { line: 1 } },
			summary: "cycle rule 'no-runtime-cycles': src/domain/bad.ts cycle src/main.ts",
			facts: {
				rule: "no-runtime-cycles",
				violationType: "cycle",
				to: "src/main.ts",
				specifier: "../ui/view.ts",
				edges: ["runtime"],
			},
		});
	});

	test("keeps runtime and type-only flavors distinct and preserves the cycle path", () => {
		const evidence = normalize(
			rawReport([
				violation({
					rule: { severity: "error", name: "no-type-only-cycles" },
					type: "cycle",
					dependencyTypes: ["local", "type-only", "import"],
					cycle: [
						{ name: "src/main.ts", dependencyTypes: ["local", "type-only", "import"] },
						{ name: "src/domain/bad.ts", dependencyTypes: ["local", "type-only", "import"] },
					],
				}),
			]),
		);
		expect(evidence.violations[0]?.edges).toEqual(["type-only"]);
		expect(evidence.violations[0]?.cycle).toEqual(["src/main.ts", "src/domain/bad.ts"]);
		const facts = evidence.findings[0]?.facts as Record<string, unknown>;
		expect(facts.cycle).toEqual(["src/main.ts", "src/domain/bad.ts"]);
	});

	test("exempts a forbidden-boundary violation through an allowed boundary as visible evidence", () => {
		const evidence = normalize(
			rawReport([violation({ to: "src/shared/util.ts", unresolvedTo: "../shared/util.ts" })]),
			{ ...fullCoverage(), representedFiles: SELECTION },
		);
		expect(evidence.violations).toEqual([]);
		expect(evidence.allowedDependencies).toEqual([
			{
				rule: "allow-domain-shared",
				from: "src/domain/bad.ts",
				to: "src/shared/util.ts",
				specifier: "../shared/util.ts",
			},
		]);
		expect(evidence.findings.map((finding) => finding.kind)).toEqual([
			"provider.dependency-cruiser.allowed-dependency",
		]);
	});

	test("does not exempt a violation whose edge flavors the allowed boundary does not govern", () => {
		const evidence = normalize(
			rawReport([
				violation({
					dependencyTypes: ["local", "type-only", "import"],
					to: "src/shared/util.ts",
				}),
			]),
		);
		expect(evidence.violations).toHaveLength(1);
		expect(evidence.violations[0]?.edges).toEqual(["type-only"]);
		expect(evidence.allowedDependencies).toEqual([]);
	});

	test("never exempts cycle or unresolved violations — only forbidden boundaries carry exceptions", () => {
		const evidence = normalize(
			rawReport([
				violation({
					rule: { severity: "error", name: "no-unresolved-imports" },
					type: "dependency",
					to: "./missing.ts",
					unresolvedTo: "./missing.ts",
				}),
			]),
		);
		expect(evidence.violations).toHaveLength(1);
		expect(evidence.violations[0]?.type).toBe("unresolved");
		expect(evidence.allowedDependencies).toEqual([]);
	});

	test("rejects evidence naming a rule the policy does not declare, and origins outside the selection", () => {
		expect(() =>
			normalize(rawReport([violation({ rule: { severity: "error", name: "foreign-rule" } })])),
		).toThrow(InvalidDependencyCruiserEvidenceError);
		expect(() => normalize(rawReport([violation({ from: "src/elsewhere.ts" })]))).toThrow(
			InvalidDependencyCruiserEvidenceError,
		);
	});

	test("counts only production-to-production edges with type-only and dynamic detail", () => {
		const evidence = normalize(rawReport([]));
		const edges = evidence.metrics.find((metric) => metric.id.endsWith("graph.edges"));
		expect(edges?.value).toBe(3);
		expect(edges?.detail).toEqual({ typeOnly: 1, dynamic: 1 });
	});

	test("records the nodes metric complete only when the graph asserts the whole selection", () => {
		const complete = normalize(rawReport([]));
		const nodes = complete.metrics.find((metric) => metric.id.endsWith("graph.nodes"));
		expect(nodes?.state).toBe("complete");
		expect(nodes?.value).toBe(3);

		const partial = normalize(rawReport([]), {
			...fullCoverage(),
			representedFiles: ["src/main.ts"],
			missingFiles: ["src/domain/bad.ts", "src/ui/view.ts"],
		});
		const partialNodes = partial.metrics.find((metric) => metric.id.endsWith("graph.nodes"));
		expect(partialNodes?.state).toBe("incomplete");
		expect(partialNodes?.reason).toContain("does not assert 2 of 3 staged files");
		expect(partialNodes?.reason).toContain("successful empty graph");
	});

	test("keeps stub classes separate in the stubs metric", () => {
		const evidence = normalize(rawReport([]), {
			...fullCoverage(),
			stubs: [
				{ source: "fs", kind: "builtin" },
				{ source: "zod", kind: "external" },
				{ source: "./missing.ts", kind: "unresolved-local" },
			],
		});
		const stubs = evidence.metrics.find((metric) => metric.id.endsWith("graph.stubs"));
		expect(stubs?.value).toBe(3);
		expect(stubs?.detail).toEqual({
			classes: { builtin: 1, external: 1, "unresolved-local": 1 },
		});
	});

	test("normalizes a zero-rule policy to truthful zeros, never a coherence claim", () => {
		const evidence = normalizeDependencyCruiserReport(
			rawReport([]),
			compileArchitecturePolicy({ rules: [] }),
			fullCoverage(),
			SELECTION,
		);
		expect(evidence.violations).toEqual([]);
		expect(evidence.findings).toEqual([]);
		const violations = evidence.metrics.find((metric) => metric.id.endsWith("violations"));
		expect(violations?.value).toBe(0);
	});

	test("is deterministic over a reordered report and findings", () => {
		const first = rawReport([
			violation({ rule: { severity: "error", name: "no-runtime-cycles" } }),
			violation({
				rule: { severity: "error", name: "no-type-only-cycles" },
				dependencyTypes: ["local", "type-only", "import"],
			}),
		]);
		const second = rawReport([
			violation({
				rule: { severity: "error", name: "no-type-only-cycles" },
				dependencyTypes: ["local", "type-only", "import"],
			}),
			violation({ rule: { severity: "error", name: "no-runtime-cycles" } }),
		]);
		expect(normalize(first)).toEqual(normalize(second));
	});

	test("orders same-rule violations totally: module, then target, then specifier", () => {
		const evidence = normalize(
			rawReport([
				violation({ from: "src/main.ts", to: "src/ui/view.ts", unresolvedTo: "../ui/view.ts" }),
				violation({ from: "src/main.ts", to: "src/ui/view.ts", unresolvedTo: "../ui/view2.ts" }),
				violation({ from: "src/domain/bad.ts", to: "src/ui/view.ts" }),
			]),
		);
		expect(
			evidence.violations.map((violation) => [violation.from, violation.to, violation.specifier]),
		).toEqual([
			["src/domain/bad.ts", "src/ui/view.ts", "../ui/view.ts"],
			["src/main.ts", "src/ui/view.ts", "../ui/view.ts"],
			["src/main.ts", "src/ui/view.ts", "../ui/view2.ts"],
		]);
		// Findings of one kind follow the same total order by path.
		expect(evidence.findings.map((finding) => finding.path)).toEqual([
			"src/domain/bad.ts",
			"src/main.ts",
			"src/main.ts",
		]);
	});
});
