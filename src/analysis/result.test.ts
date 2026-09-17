import { describe, expect, test } from "bun:test";
import {
	type AnalysisIdentity,
	analysisIdentitySchema,
	analysisResultSchema,
	type ObservedCoverage,
	observedCoverageSchema,
	providerIdentitySchema,
} from "../contract/index.ts";
import {
	type CloneAnalysisProduct,
	type GraphAnalysisProduct,
	type InternalAnalysisResult,
	toContractResult,
} from "./result.ts";

const nativeProvider = providerIdentitySchema.parse({
	kind: "native",
	id: "trellis.duplication",
	toolVersion: "0.2.1",
	adapterVersion: "0.2.1",
	mode: "shared-parse",
	options: {},
});

const analysis: AnalysisIdentity = analysisIdentitySchema.parse({
	selection: {
		sourceSets: ["production"],
		files: [{ path: "src/a.ts", fingerprint: "a".repeat(64) }],
	},
	parser: { engine: "trellis.typescript", version: "6.0.3" },
	options: {},
});

const coverage: ObservedCoverage = observedCoverageSchema.parse({
	analyzedFiles: ["src/a.ts"],
	analyzedLines: 110,
	diagnostics: [],
	unsupported: [],
});

const graph: GraphAnalysisProduct = {
	nodes: [{ path: "src/a.ts", packagePath: ".", sourceSet: "production" }],
	edges: [
		{
			from: "src/a.ts",
			kind: "import",
			typeOnly: false,
			specifier: "./b.ts",
			range: { start: { line: 1 }, end: { line: 1 } },
			resolution: { status: "local", target: "src/b.ts" },
		},
	],
};

const clones: CloneAnalysisProduct = {
	groups: [
		{
			id: "clone-group-1",
			tokenCount: 50,
			members: [
				{
					path: "src/a.ts",
					range: { start: { line: 3 }, end: { line: 17 } },
					tokenCount: 50,
					lineCount: 15,
				},
				{
					path: "src/b.ts",
					range: { start: { line: 5 }, end: { line: 19 } },
					tokenCount: 50,
					lineCount: 15,
				},
			],
		},
	],
};

const internal: InternalAnalysisResult = {
	provider: nativeProvider,
	state: "complete",
	analysis,
	observedCoverage: coverage,
	products: { graph, clones },
};

describe("toContractResult", () => {
	test("strips internal products so the result validates against the minimum contract", () => {
		const contract = toContractResult(internal);
		expect("products" in contract).toBe(false);
		expect(analysisResultSchema.parse(contract)).toEqual(contract);
	});

	test("returns a contract view for a product-free result unchanged", () => {
		const productFree: InternalAnalysisResult = {
			provider: nativeProvider,
			state: "complete",
			analysis,
			observedCoverage: coverage,
		};
		expect(toContractResult(productFree)).toEqual(productFree);
	});

	test("keeps optional internal products out of the serialized minimum", () => {
		expect(analysisResultSchema.safeParse(internal).success).toBe(false);
		const graphOnly: InternalAnalysisResult = {
			provider: nativeProvider,
			state: "complete",
			analysis,
			observedCoverage: coverage,
			products: { graph },
		};
		expect(analysisResultSchema.safeParse(graphOnly).success).toBe(false);
		expect(toContractResult(graphOnly).metrics).toBeUndefined();
	});
});
