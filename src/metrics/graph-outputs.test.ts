import { describe, expect, test } from "bun:test";
import { collectOutputMappings, sourceCandidatesForOutput } from "./graph-outputs.ts";

describe("sourceCandidatesForOutput", () => {
	test("maps tsconfig outDir to rootDir before the conventional mapping", () => {
		expect(
			sourceCandidatesForOutput("./build/esm/index.js", [{ outDir: "build/esm", rootDir: "lib" }]),
		).toEqual(["lib/index", "src/esm/index"]);
	});

	test("strips declaration and module extensions", () => {
		expect(sourceCandidatesForOutput("./dist/index.d.mts", [])).toEqual(["src/index"]);
		expect(sourceCandidatesForOutput("dist/sub/a.cjs", [])).toEqual(["src/sub/a"]);
	});

	test("returns nothing for entries outside any output directory", () => {
		expect(sourceCandidatesForOutput("./src/index.ts", [])).toEqual([]);
		expect(sourceCandidatesForOutput("./distribution/a.js", [])).toEqual([]);
	});
});

describe("collectOutputMappings", () => {
	test("reads outDir and declarationDir against rootDir, deduplicated in config order", () => {
		const configs: Record<string, { outDir?: string; declarationDir?: string; rootDir?: string }> =
			{
				"/pkg/tsconfig.json": { outDir: "/pkg/dist", rootDir: "/pkg/src" },
				"/pkg/tsconfig.build.json": {
					outDir: "/pkg/dist",
					declarationDir: "/pkg/types",
					rootDir: "/pkg/src",
				},
			};
		expect(collectOutputMappings("/pkg", (path) => configs[path])).toEqual([
			{ outDir: "dist", rootDir: "src" },
			{ outDir: "types", rootDir: "src" },
		]);
	});

	test("ignores outputs outside the package and absent configs", () => {
		expect(collectOutputMappings("/pkg", () => undefined)).toEqual([]);
		expect(
			collectOutputMappings("/pkg", (path) =>
				path.endsWith("tsconfig.json") ? { outDir: "/elsewhere/dist" } : undefined,
			),
		).toEqual([]);
	});
});
