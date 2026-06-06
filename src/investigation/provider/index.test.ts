import { describe, expect, test } from "bun:test";
import { FINDINGS_EXTENSION_PATH, investigate } from "./index.ts";
import { errorTurn, makeFakePi, submitFindingsTurn } from "./pi/fake-pi.ts";
import { AREA_ENV_VAR } from "./pi/findings-extension.ts";

const validDocFindings = {
	readme: { present: true, atRoot: true, hasSetup: true, hasUsage: true },
	buildCommandDocumented: true,
	docGenerationMechanisms: [],
	runbooks: [],
	singleCommandSetupDocumented: false,
	keyDocs: [],
	architectureDocs: [],
};

const sourceEnv = { PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-oai" };

describe("investigate", () => {
	test("returns validated findings and spawns Pi with the area's argv/env (SPEC §9.0)", async () => {
		const fake = makeFakePi([submitFindingsTurn(validDocFindings)]);
		const result = await investigate("/tmp/repo", "documentation", {
			spawn: fake.spawn,
			sourceEnv,
		});
		expect(result).toEqual({ ok: true, area: "documentation", findings: validDocFindings });

		const ctx = fake.spawnCtx;
		expect(ctx?.cwd).toBe("/tmp/repo");
		expect(ctx?.argv).toContain("--mode");
		expect(ctx?.argv).toContain("rpc");
		expect(ctx?.argv).toContain(FINDINGS_EXTENSION_PATH);
		expect(ctx?.argv).toContain("anthropic"); // built-in default provider
		// env carries the area selector + the anthropic base key, never on argv
		expect(ctx?.env[AREA_ENV_VAR]).toBe("documentation");
		expect(ctx?.env.ANTHROPIC_API_KEY).toBe("sk-ant");
		expect(ctx?.env.OPENAI_API_KEY).toBeUndefined();
		expect(ctx?.argv.some((a) => a.includes("sk-ant"))).toBe(false);
	});

	test("CLI provider/model flags flow to argv and select the provider's env keys (§9.4)", async () => {
		const fake = makeFakePi([submitFindingsTurn(validDocFindings)]);
		await investigate("/tmp/repo", "documentation", {
			provider: "OpenAI",
			model: "gpt-4o-mini",
			spawn: fake.spawn,
			sourceEnv,
		});
		const ctx = fake.spawnCtx;
		expect(ctx?.argv).toContain("openai"); // lowercased
		expect(ctx?.argv).toContain("gpt-4o-mini");
		expect(ctx?.env.OPENAI_API_KEY).toBe("sk-oai");
	});

	test("targets.yaml defaults are used when no CLI flag overrides them", async () => {
		const fake = makeFakePi([submitFindingsTurn(validDocFindings)]);
		await investigate("/tmp/repo", "documentation", {
			targetDefaults: { provider: "groq", model: "llama-3" },
			spawn: fake.spawn,
			sourceEnv,
		});
		expect(fake.spawnCtx?.argv).toContain("groq");
		expect(fake.spawnCtx?.argv).toContain("llama-3");
	});

	test("a failed run degrades the area to a no-detector-shaped result (never a pass)", async () => {
		const fake = makeFakePi([errorTurn]);
		const result = await investigate("/tmp/repo", "documentation", {
			spawn: fake.spawn,
			sourceEnv,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.area).toBe("documentation");
			expect(result.reason).toContain("stopReason:error");
		}
	});

	test("honours an explicit extension-path override on argv", async () => {
		const fake = makeFakePi([submitFindingsTurn(validDocFindings)]);
		await investigate("/tmp/repo", "documentation", {
			extensionPath: "/custom/ext.ts",
			spawn: fake.spawn,
			sourceEnv,
		});
		expect(fake.spawnCtx?.argv).toContain("/custom/ext.ts");
		expect(fake.spawnCtx?.argv).not.toContain(FINDINGS_EXTENSION_PATH);
	});
});
