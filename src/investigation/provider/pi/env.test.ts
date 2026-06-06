import { describe, expect, test } from "bun:test";
import { buildPiEnv, PI_BASE_ENV_KEYS, piEnvKeysFor } from "./env.ts";
import { AREA_ENV_VAR } from "./findings-extension.ts";

describe("piEnvKeysFor", () => {
	test("anthropic (and the empty provider) get only the base triple", () => {
		expect(piEnvKeysFor("anthropic")).toEqual(PI_BASE_ENV_KEYS);
		expect(piEnvKeysFor("")).toEqual(PI_BASE_ENV_KEYS);
	});

	test("a non-anthropic provider appends its provider-specific keys", () => {
		expect(piEnvKeysFor("openai")).toEqual([
			...PI_BASE_ENV_KEYS,
			"OPENAI_API_KEY",
			"OPENAI_BASE_URL",
		]);
		expect(piEnvKeysFor("google")).toEqual([...PI_BASE_ENV_KEYS, "GEMINI_API_KEY"]);
	});

	test("provider lookup is case-insensitive", () => {
		expect(piEnvKeysFor("OpenAI")).toEqual(piEnvKeysFor("openai"));
	});

	test("an unknown provider contributes nothing beyond the base", () => {
		expect(piEnvKeysFor("acme")).toEqual(PI_BASE_ENV_KEYS);
	});
});

describe("buildPiEnv", () => {
	const sourceEnv = {
		PATH: "/usr/bin",
		ANTHROPIC_API_KEY: "sk-ant-xxx",
		ANTHROPIC_AUTH_TOKEN: "tok",
		OPENAI_API_KEY: "sk-oai-yyy",
		GEMINI_API_KEY: "gem-zzz",
		UNRELATED: "nope",
	};

	test("forwards only the base keys for anthropic, plus PATH and the area selector", () => {
		const env = buildPiEnv({ provider: "anthropic", area: "documentation", sourceEnv });
		expect(env).toEqual({
			PATH: "/usr/bin",
			ANTHROPIC_API_KEY: "sk-ant-xxx",
			ANTHROPIC_AUTH_TOKEN: "tok",
			[AREA_ENV_VAR]: "documentation",
		});
		expect(env.OPENAI_API_KEY).toBeUndefined();
		expect(env.UNRELATED).toBeUndefined();
	});

	test("adds the provider-specific key when a non-anthropic provider is selected", () => {
		const env = buildPiEnv({ provider: "openai", area: "test-layout", sourceEnv });
		expect(env.OPENAI_API_KEY).toBe("sk-oai-yyy");
		expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-xxx"); // base is always forwarded
		expect(env.GEMINI_API_KEY).toBeUndefined(); // wrong provider's key is not leaked
		expect(env[AREA_ENV_VAR]).toBe("test-layout");
	});

	test("omits keys that are unset on the host (no empty values)", () => {
		const env = buildPiEnv({
			provider: "anthropic",
			area: "agent-config",
			sourceEnv: { PATH: "/bin", ANTHROPIC_API_KEY: "" },
		});
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env).toEqual({ PATH: "/bin", [AREA_ENV_VAR]: "agent-config" });
	});
});
