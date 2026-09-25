import { describe, expect, test } from "bun:test";
import { exportsCandidates, manifestCandidates, wildcardMatch } from "./graph-workspace.ts";

describe("wildcardMatch", () => {
	test("matches a single-star pattern and returns the middle", () => {
		expect(wildcardMatch("./feature/*", "./feature/flags")).toBe("flags");
		expect(wildcardMatch("./*", "./x")).toBe("x");
	});

	test("rejects non-matches and multi-star patterns", () => {
		expect(wildcardMatch("./feature/*", "./other/flags")).toBeNull();
		expect(wildcardMatch("./feature/*.ts", "./feature/flags.js")).toBeNull();
		expect(wildcardMatch("./a/*/b/*", "./a/x/b/y")).toBeNull();
		expect(wildcardMatch("./plain", "./plain")).toBeNull();
	});
});

describe("exportsCandidates", () => {
	test("a string exports field serves only the root", () => {
		expect(exportsCandidates("./src/index.ts", "")).toEqual({
			candidates: ["./src/index.ts"],
		});
		expect(exportsCandidates("./src/index.ts", "sub")).toEqual({
			failure: "exports-encapsulation",
		});
	});

	test("exact entries win; conditions follow the documented order", () => {
		const exports = {
			".": { import: "./src/esm.ts", default: "./dist/cjs.js" },
			"./types-only": { types: "./src/types.d.ts" },
		};
		expect(exportsCandidates(exports, "")).toEqual({
			candidates: ["./src/esm.ts", "./dist/cjs.js"],
		});
		expect(exportsCandidates(exports, "types-only")).toEqual({
			candidates: ["./src/types.d.ts"],
		});
	});

	test("wildcard entries substitute the matched middle; longest prefix wins", () => {
		const exports = {
			"./*": "./src/*.ts",
			"./feature/*": "./src/feature/*.ts",
		};
		expect(exportsCandidates(exports, "feature/flags")).toEqual({
			candidates: ["./src/feature/flags.ts"],
		});
		expect(exportsCandidates(exports, "other")).toEqual({ candidates: ["./src/other.ts"] });
	});

	test("unlisted subpaths are encapsulated, never probed", () => {
		expect(exportsCandidates({ ".": "./src/index.ts" }, "secret")).toEqual({
			failure: "exports-encapsulation",
		});
	});

	test("shapes beyond the documented subset fail as unsupported", () => {
		expect(exportsCandidates({ ".": { import: { nested: "./a.ts" } } }, "")).toEqual({
			failure: "unsupported-exports",
		});
		expect(exportsCandidates({ ".": { browser: "./a.ts" } }, "")).toEqual({
			failure: "unsupported-exports",
		});
		expect(exportsCandidates({ ".": { import: 7 } }, "")).toEqual({
			failure: "unsupported-exports",
		});
		expect(exportsCandidates(42, "")).toEqual({ failure: "unsupported-exports" });
	});

	test("fallback arrays and nested conditions yield every target in priority order", () => {
		expect(exportsCandidates(["./a.ts", "./b.ts"], "")).toEqual({
			candidates: ["./a.ts", "./b.ts"],
		});
		expect(exportsCandidates({ ".": ["./a.ts", { import: "./b.ts" }] }, "")).toEqual({
			candidates: ["./a.ts", "./b.ts"],
		});
		const nested = {
			".": {
				import: { types: "./dist/index.d.mts", default: "./dist/index.mjs" },
				require: "./dist/index.cjs",
			},
		};
		expect(exportsCandidates(nested, "")).toEqual({
			candidates: ["./dist/index.mjs", "./dist/index.d.mts", "./dist/index.cjs"],
		});
	});

	test("tsconfig customConditions and source-named conditions outrank the built-in conditions", () => {
		const exports = {
			".": { "@acme/source": "./src/custom.ts", source: "./src/index.ts", import: "./dist/x.js" },
		};
		expect(exportsCandidates(exports, "")).toEqual({
			candidates: ["./src/custom.ts", "./src/index.ts", "./dist/x.js"],
		});
		expect(
			exportsCandidates({ ".": { "x-custom": "./a.ts", import: "./b.js" } }, "", ["x-custom"]),
		).toEqual({
			candidates: ["./a.ts", "./b.js"],
		});
		expect(exportsCandidates(exports, "", ["@acme/source"])).toEqual({
			candidates: ["./src/custom.ts", "./src/index.ts", "./dist/x.js"],
		});
	});

	test("a root-only condition object is sugar for the root entry", () => {
		expect(exportsCandidates({ import: "./src/a.ts" }, "")).toEqual({
			candidates: ["./src/a.ts"],
		});
		expect(exportsCandidates({ import: "./src/a.ts" }, "sub")).toEqual({
			failure: "exports-encapsulation",
		});
	});
});

describe("manifestCandidates", () => {
	test("root falls back through main, then types, then index", () => {
		expect(manifestCandidates({ main: "./src/main.ts" }, "")).toEqual(["./src/main.ts"]);
		expect(manifestCandidates({ types: "./src/types.d.ts" }, "")).toEqual(["./src/types.d.ts"]);
		expect(manifestCandidates({ main: 7 }, "")).toEqual(["index"]);
		expect(manifestCandidates({}, "")).toEqual(["index"]);
	});

	test("a subpath resolves as a plain file path inside the package", () => {
		expect(manifestCandidates({ main: "./src/main.ts" }, "src/other")).toEqual(["src/other"]);
	});
});
