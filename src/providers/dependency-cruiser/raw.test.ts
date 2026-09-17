/**
 * Raw dependency-cruiser report validation tests (plan `pl-43c5` step 22 —
 * trellis-adbf): the strict schema rejects malformed and foreign payloads
 * with located reasons, and the evidence validation flags a foreign rule
 * set, out-of-scope origins and duplicated modules — the callers turn
 * those into `incomplete` analysis, never clean evidence.
 */
import { describe, expect, test } from "bun:test";
import {
	parseRawDependencyCruiserReport,
	type RawDependencyCruiserReport,
	validateRawDependencyCruiserEvidence,
} from "./raw.ts";

/** One minimal schema-valid report over a two-module graph. */
function minimalReport(): Record<string, unknown> {
	return {
		modules: [
			{
				source: "src/a.ts",
				dependencies: [
					{
						module: "./b.ts",
						resolved: "src/b.ts",
						moduleSystem: "es6",
						dependencyTypes: ["local", "import"],
						dynamic: false,
						coreModule: false,
						followable: true,
						couldNotResolve: false,
						matchesDoNotFollow: false,
						exoticallyRequired: false,
						circular: false,
						valid: false,
						rules: [{ severity: "error", name: "no-cycles" }],
					},
				],
				dependents: [],
				orphan: false,
				valid: true,
			},
			{
				source: "src/b.ts",
				dependencies: [],
				dependents: ["src/a.ts"],
				orphan: false,
				valid: true,
			},
			{
				source: "zod",
				dependencies: [],
				dependents: ["src/a.ts"],
				orphan: false,
				valid: true,
				coreModule: false,
				couldNotResolve: true,
				followable: false,
				matchesDoNotFollow: false,
				dependencyTypes: ["unknown"],
			},
		],
		summary: {
			violations: [
				{
					type: "cycle",
					rule: { severity: "error", name: "no-cycles" },
					from: "src/a.ts",
					to: "src/b.ts",
					unresolvedTo: "./b.ts",
					dependencyTypes: ["local", "import"],
					cycle: [
						{ name: "src/b.ts", dependencyTypes: ["local", "import"] },
						{ name: "src/a.ts", dependencyTypes: ["local", "import"] },
					],
				},
			],
			error: 1,
			warn: 0,
			info: 0,
			ignore: 0,
			totalCruised: 3,
			totalDependenciesCruised: 1,
			optionsUsed: { baseDir: "/machine/path", rulesFile: "/machine/path/cruise.json" },
			ruleSetUsed: { forbidden: [] },
			environment: { node: "v1" },
		},
	};
}

/** The parsed report of the minimal payload (fails fast when invalid). */
function parsed(): RawDependencyCruiserReport {
	const result = parseRawDependencyCruiserReport(JSON.stringify(minimalReport()));
	if (!result.ok) throw new Error(result.reasons.join("; "));
	return result.report;
}

describe("parseRawDependencyCruiserReport", () => {
	test("parses a schema-valid report and strips the tool's machine-context records", () => {
		const report = parsed();
		expect(report.modules).toHaveLength(3);
		expect(report.summary.violations).toHaveLength(1);
		expect(report.summary).not.toHaveProperty("optionsUsed");
		expect(report.summary).not.toHaveProperty("ruleSetUsed");
		expect(report.summary).not.toHaveProperty("environment");
	});

	test("rejects malformed JSON with a located reason", () => {
		const result = parseRawDependencyCruiserReport("{not json");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reasons[0]).toContain("not valid JSON");
	});

	test("rejects an unknown payload shape actionably", () => {
		const result = parseRawDependencyCruiserReport(JSON.stringify({ duplicates: [] }));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reasons.join("; ")).toContain("Unrecognized key");
	});

	test("rejects a dependency edge with an unrecognized key", () => {
		const payload = minimalReport();
		const modules = payload.modules as { dependencies: Record<string, unknown>[] }[];
		const edge = modules[0]?.dependencies[0];
		if (edge === undefined) throw new Error("expected a dependency edge");
		edge.surprise = true;
		const result = parseRawDependencyCruiserReport(JSON.stringify(payload));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reasons.join("; ")).toContain("surprise");
	});

	test("rejects a cycle violation without its cycle path", () => {
		const payload = minimalReport();
		const summary = payload.summary as { violations: Record<string, unknown>[] };
		delete summary.violations[0]?.cycle;
		const result = parseRawDependencyCruiserReport(JSON.stringify(payload));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reasons.join("; ")).toContain("cycle path");
	});

	test("rejects a summary whose severity totals do not account for its violations", () => {
		const payload = minimalReport();
		(payload.summary as Record<string, unknown>).error = 0;
		const result = parseRawDependencyCruiserReport(JSON.stringify(payload));
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.reasons.join("; ")).toContain("account for every reported violation");
	});

	test("accepts the tool's protocol/mimeType import fields", () => {
		const payload = minimalReport();
		const modules = payload.modules as { dependencies: Record<string, unknown>[] }[];
		modules[0]?.dependencies.push({
			module: "node:fs",
			resolved: "fs",
			moduleSystem: "es6",
			dependencyTypes: ["core", "import"],
			dynamic: false,
			coreModule: true,
			followable: false,
			couldNotResolve: false,
			matchesDoNotFollow: false,
			exoticallyRequired: false,
			circular: false,
			valid: true,
			protocol: "node:",
		});
		const result = parseRawDependencyCruiserReport(JSON.stringify(payload));
		expect(result.ok).toBe(true);
	});
});

describe("validateRawDependencyCruiserEvidence", () => {
	test("accepts a report whose violations name compiled rules inside the staged scope", () => {
		const report = parsed();
		const reasons = validateRawDependencyCruiserEvidence(
			report,
			new Set(["src/a.ts", "src/b.ts"]),
			new Set(["no-cycles"]),
		);
		expect(reasons).toEqual([]);
	});

	test("flags a violation naming a rule the compiled policy does not declare", () => {
		const reasons = validateRawDependencyCruiserEvidence(
			parsed(),
			new Set(["src/a.ts", "src/b.ts"]),
			new Set(["some-other-rule"]),
		);
		expect(reasons.join("; ")).toContain("which the compiled policy does not declare");
	});

	test("flags a violation originating outside the staged selection", () => {
		const reasons = validateRawDependencyCruiserEvidence(
			parsed(),
			new Set(["src/b.ts"]),
			new Set(["no-cycles"]),
		);
		expect(reasons.join("; ")).toContain("outside the staged selection");
	});

	test("flags a duplicated module source — a graph is not a multiset", () => {
		const report = parsed();
		const first = report.modules[0];
		if (first === undefined) throw new Error("expected a first module");
		const duplicate = { ...first };
		const withDuplicate: RawDependencyCruiserReport = {
			...report,
			modules: [...report.modules, duplicate],
		};
		const reasons = validateRawDependencyCruiserEvidence(
			withDuplicate,
			new Set(["src/a.ts", "src/b.ts"]),
			new Set(["no-cycles"]),
		);
		expect(reasons.join("; ")).toContain("reported twice");
	});
});
