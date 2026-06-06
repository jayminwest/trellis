import { afterEach, describe, expect, test } from "bun:test";
import { AREA_IDS } from "../../areas.ts";
import activate, {
	AREA_ENV_VAR,
	type PiToolDefinition,
	resolveAreaFromEnv,
	SUBMIT_FINDINGS_TOOL,
	submitFindingsTool,
} from "./findings-extension.ts";

afterEach(() => {
	delete process.env[AREA_ENV_VAR];
});

describe("resolveAreaFromEnv", () => {
	test("returns the area id when the env var names a known area", () => {
		expect(resolveAreaFromEnv({ [AREA_ENV_VAR]: "documentation" })).toBe("documentation");
	});

	test("throws when the env var is unset", () => {
		expect(() => resolveAreaFromEnv({})).toThrow(/not set/);
	});

	test("throws when the env var names an unknown area", () => {
		expect(() => resolveAreaFromEnv({ [AREA_ENV_VAR]: "bogus" })).toThrow(/not a known/);
	});
});

describe("submitFindingsTool", () => {
	test("derives a JSON-schema parameter object from each area's zod schema", () => {
		for (const area of AREA_IDS) {
			const tool = submitFindingsTool(area);
			expect(tool.name).toBe(SUBMIT_FINDINGS_TOOL);
			const params = tool.parameters as { type?: string; properties?: Record<string, unknown> };
			expect(params.type).toBe("object");
			expect(Object.keys(params.properties ?? {}).length).toBeGreaterThan(0);
		}
	});

	test("the handler acknowledges receipt and hints termination (capture is off-stream)", async () => {
		const tool = submitFindingsTool("documentation");
		const result = await tool.execute("call-1", { anything: true });
		expect(result.terminate).toBe(true);
		expect(result.content[0]?.text).toContain("received");
	});
});

describe("activate (ExtensionFactory)", () => {
	test("registers exactly one submit_findings tool for the env-selected area", () => {
		process.env[AREA_ENV_VAR] = "test-layout";
		const registered: PiToolDefinition[] = [];
		activate({ registerTool: (t) => registered.push(t) });
		expect(registered).toHaveLength(1);
		expect(registered[0]?.name).toBe(SUBMIT_FINDINGS_TOOL);
	});

	test("throws (Pi surfaces an extension_error → no-detector) when no area is set", () => {
		expect(() => activate({ registerTool: () => {} })).toThrow();
	});
});
