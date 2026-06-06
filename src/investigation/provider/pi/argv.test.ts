import { describe, expect, test } from "bun:test";
import {
	buildPiArgv,
	DEFAULT_MODEL,
	DEFAULT_PROVIDER,
	PI_TOOL_ALLOWLIST,
	READ_ONLY_BUILTINS,
	resolveProviderModel,
	SUBMIT_FINDINGS_TOOL,
} from "./argv.ts";

describe("resolveProviderModel", () => {
	test("falls back to the built-in default when nothing is supplied", () => {
		expect(resolveProviderModel()).toEqual({ provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL });
	});

	test("targets.yaml defaults override the built-in constant", () => {
		expect(resolveProviderModel(undefined, { provider: "openai", model: "gpt-4o-mini" })).toEqual({
			provider: "openai",
			model: "gpt-4o-mini",
		});
	});

	test("CLI flags win over targets.yaml defaults (SPEC §9.4 precedence)", () => {
		expect(
			resolveProviderModel(
				{ provider: "google", model: "gemini-2.0" },
				{ provider: "openai", model: "gpt-4o-mini" },
			),
		).toEqual({ provider: "google", model: "gemini-2.0" });
	});

	test("provider is lowercased; model is passed through verbatim", () => {
		expect(resolveProviderModel({ provider: "OpenAI", model: "GPT-4o" })).toEqual({
			provider: "openai",
			model: "GPT-4o",
		});
	});

	test("blank/whitespace values fall through to the next precedence layer", () => {
		expect(
			resolveProviderModel({ provider: "  ", model: "" }, { provider: "groq", model: "  " }),
		).toEqual({ provider: "groq", model: DEFAULT_MODEL });
	});
});

describe("PI_TOOL_ALLOWLIST", () => {
	test("is the read-only builtins plus submit_findings — no mutating tool", () => {
		expect(PI_TOOL_ALLOWLIST).toEqual([...READ_ONLY_BUILTINS, SUBMIT_FINDINGS_TOOL]);
		for (const banned of ["bash", "edit", "write"]) {
			expect(PI_TOOL_ALLOWLIST).not.toContain(banned);
		}
	});
});

describe("buildPiArgv", () => {
	const base = {
		providerModel: { provider: "anthropic", model: "claude-haiku-4-5" },
		extensionPath: "/abs/findings-extension.ts",
		systemPrompt: "investigate documentation",
	};

	test("renders the locked one-shot read-only RPC flag set (SPEC §9.1)", () => {
		expect(buildPiArgv(base)).toEqual([
			"pi",
			"--mode",
			"rpc",
			"--no-session",
			"--no-extensions",
			"-e",
			"/abs/findings-extension.ts",
			"--offline",
			"--no-context-files",
			"--provider",
			"anthropic",
			"--model",
			"claude-haiku-4-5",
			"--tools",
			"read,grep,find,ls,submit_findings",
			"--system-prompt",
			"investigate documentation",
		]);
	});

	test("substitutes the resolved provider/model and respects a custom pi binary", () => {
		const argv = buildPiArgv({
			...base,
			providerModel: { provider: "openai", model: "gpt-4o-mini" },
			piBin: "/opt/pi",
		});
		expect(argv[0]).toBe("/opt/pi");
		expect(argv).toContain("openai");
		expect(argv).toContain("gpt-4o-mini");
	});

	test("never places an API key on argv (only --provider/--model carry config)", () => {
		const argv = buildPiArgv(base);
		expect(argv.some((a) => /--api-key|API_KEY|sk-/i.test(a))).toBe(false);
	});
});
