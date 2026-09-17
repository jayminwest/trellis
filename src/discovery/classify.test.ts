import { describe, expect, test } from "bun:test";
import type { SourceConfig } from "../contract/index.ts";
import {
	classifyTsFile,
	isTypeScriptSource,
	isUnsupportedSource,
	UNSUPPORTED_SOURCE_EXTENSIONS,
} from "./classify.ts";

describe("isTypeScriptSource", () => {
	test("recognizes .ts/.tsx/.mts/.cts including declarations", () => {
		expect(isTypeScriptSource("src/a.ts")).toBe(true);
		expect(isTypeScriptSource("src/a.tsx")).toBe(true);
		expect(isTypeScriptSource("src/a.mts")).toBe(true);
		expect(isTypeScriptSource("src/a.cts")).toBe(true);
		expect(isTypeScriptSource("src/a.d.ts")).toBe(true);
		expect(isTypeScriptSource("src/a.js")).toBe(false);
	});
});

describe("isUnsupportedSource", () => {
	test("counts known non-TS source extensions, case-insensitively", () => {
		expect(isUnsupportedSource("main.py")).toBe(true);
		expect(isUnsupportedSource("App.SWIFT")).toBe(true);
		expect(isUnsupportedSource("component.jsx")).toBe(true);
		expect(isUnsupportedSource("README.md")).toBe(false);
		expect(isUnsupportedSource("Makefile")).toBe(false);
	});

	test("every listed extension is recognized", () => {
		for (const ext of UNSUPPORTED_SOURCE_EXTENSIONS) {
			expect(isUnsupportedSource(`file${ext}`)).toBe(true);
		}
	});
});

describe("classifyTsFile defaults", () => {
	test("plain source is production", () => {
		expect(classifyTsFile("src/index.ts")).toEqual({
			sourceSet: "production",
			rule: "default:production",
		});
	});

	test("test/spec basenames and test dirs classify as test", () => {
		expect(classifyTsFile("src/a.test.ts").sourceSet).toBe("test");
		expect(classifyTsFile("src/a.spec.tsx").sourceSet).toBe("test");
		expect(classifyTsFile("pkg/__tests__/a.ts").sourceSet).toBe("test");
		expect(classifyTsFile("pkg/tests/a.ts").sourceSet).toBe("test");
	});

	test("vendor and third_party dirs classify as vendored", () => {
		expect(classifyTsFile("vendor/lib/a.ts").sourceSet).toBe("vendored");
		expect(classifyTsFile("third_party/a.ts").sourceSet).toBe("vendored");
	});

	test("generated dirs and .gen./.generated. basenames classify as generated", () => {
		expect(classifyTsFile("src/generated/client.ts").sourceSet).toBe("generated");
		expect(classifyTsFile("src/__generated__/q.ts").sourceSet).toBe("generated");
		expect(classifyTsFile("src/api.gen.ts").sourceSet).toBe("generated");
		expect(classifyTsFile("src/api.generated.tsx").sourceSet).toBe("generated");
	});

	test("declaration files classify as declaration-only", () => {
		expect(classifyTsFile("types/index.d.ts").sourceSet).toBe("declaration-only");
		expect(classifyTsFile("types/index.d.mts").sourceSet).toBe("declaration-only");
	});

	test("precedence: vendored > generated > declaration-only > test", () => {
		expect(classifyTsFile("vendor/gen/api.gen.ts").sourceSet).toBe("vendored");
		expect(classifyTsFile("generated/types.d.ts").sourceSet).toBe("generated");
		expect(classifyTsFile("src/a.test.d.ts").sourceSet).toBe("declaration-only");
	});
});

describe("classifyTsFile config overrides", () => {
	test("an explicit classify override wins over defaults", () => {
		const config: SourceConfig = { exclude: [], classify: { "scripts/tools/**": "test" } };
		expect(classifyTsFile("scripts/tools/build.ts", config)).toEqual({
			sourceSet: "test",
			rule: "config:classify:scripts/tools/**",
		});
	});

	test("an override can reclassify a default-test file as production", () => {
		const config: SourceConfig = { exclude: [], classify: { "src/**": "production" } };
		expect(classifyTsFile("src/a.test.ts", config).sourceSet).toBe("production");
	});

	test("overrides evaluate in sorted pattern order for deterministic ties", () => {
		const config: SourceConfig = {
			exclude: [],
			classify: { "src/**": "production", "src/a.ts": "test" },
		};
		expect(classifyTsFile("src/a.ts", config).rule).toBe("config:classify:src/**");
	});
});
