import { describe, expect, test } from "bun:test";
import {
	type AgentConfigFindings,
	agentConfigFindingsSchema,
	type DocumentationFindings,
	documentationFindingsSchema,
	FINDINGS_SCHEMAS,
	type SetupRunnabilityFindings,
	setupRunnabilityFindingsSchema,
	type TestLayoutFindings,
	testLayoutFindingsSchema,
} from "./findings.ts";

const validDocumentation: DocumentationFindings = {
	readme: { present: true, atRoot: true, hasSetup: true, hasUsage: true },
	buildCommandDocumented: true,
	docGenerationMechanisms: ["typedoc"],
	runbooks: ["RUNBOOK.md"],
	singleCommandSetupDocumented: true,
	keyDocs: [{ path: "README.md", daysSinceModified: 3 }],
	architectureDocs: ["docs/architecture.mmd"],
};

const validAgentConfig: AgentConfigFindings = {
	agentInstructionFiles: [
		{
			path: "AGENTS.md",
			hasScripts: true,
			hasBuildTestCmds: true,
			hasConventions: true,
			hasWorkflow: true,
		},
	],
	skills: [{ dir: "skills/release", hasName: true, hasDescription: true, promptNonEmpty: true }],
	validationAutomation: ["ci-runs-commands"],
	agentCoAuthorshipCommits: 12,
};

const validSetup: SetupRunnabilityFindings = {
	secretsMechanism: "env-file",
	committedSecretsFound: false,
	localServicesRequired: true,
	localServicesScripted: true,
	devcontainerPresent: true,
	devcontainerBuildEvidence: "builds",
};

const validTestLayout: TestLayoutFindings = {
	testDirs: ["src"],
	unitTestFiles: 40,
	integrationTests: { present: true, boundaries: ["db"] },
	testFileCount: 42,
	testFilesMatchingConvention: 42,
	timingSurface: true,
	parallelExecution: true,
	sharedMutableStateViolations: 0,
	flakyHandling: ["retry"],
};

describe("findings schemas accept valid facts", () => {
	test("documentation", () => {
		expect(documentationFindingsSchema.parse(validDocumentation)).toEqual(validDocumentation);
	});
	test("agent-config", () => {
		expect(agentConfigFindingsSchema.parse(validAgentConfig)).toEqual(validAgentConfig);
	});
	test("setup-runnability", () => {
		expect(setupRunnabilityFindingsSchema.parse(validSetup)).toEqual(validSetup);
	});
	test("test-layout", () => {
		expect(testLayoutFindingsSchema.parse(validTestLayout)).toEqual(validTestLayout);
	});
});

describe("findings schemas reject verdict-shaped extras (facts, never verdicts)", () => {
	test("a top-level verdict field is rejected", () => {
		expect(() =>
			documentationFindingsSchema.parse({ ...validDocumentation, passed: true }),
		).toThrow();
		expect(() =>
			agentConfigFindingsSchema.parse({ ...validAgentConfig, verdict: "pass" }),
		).toThrow();
		expect(() => setupRunnabilityFindingsSchema.parse({ ...validSetup, score: 1 })).toThrow();
		expect(() => testLayoutFindingsSchema.parse({ ...validTestLayout, grade: "A" })).toThrow();
	});

	test("a nested verdict field is rejected (strictObject all the way down)", () => {
		expect(() =>
			agentConfigFindingsSchema.parse({
				...validAgentConfig,
				skills: [
					{ dir: "s", hasName: true, hasDescription: true, promptNonEmpty: true, valid: true },
				],
			}),
		).toThrow();
	});
});

describe("findings schemas reject malformed facts", () => {
	test("negative counts rejected", () => {
		expect(() =>
			agentConfigFindingsSchema.parse({ ...validAgentConfig, agentCoAuthorshipCommits: -1 }),
		).toThrow();
	});
	test("unknown enum members rejected", () => {
		expect(() =>
			setupRunnabilityFindingsSchema.parse({ ...validSetup, secretsMechanism: "magic" }),
		).toThrow();
	});
	test("more convention-matching files than total is a fact-sanity violation", () => {
		expect(() =>
			testLayoutFindingsSchema.parse({
				...validTestLayout,
				testFileCount: 1,
				testFilesMatchingConvention: 2,
			}),
		).toThrow();
	});
});

describe("FINDINGS_SCHEMAS", () => {
	test("maps each area id to its schema", () => {
		expect(Object.keys(FINDINGS_SCHEMAS).sort()).toEqual(
			["agent-config", "documentation", "setup-runnability", "test-layout"].sort(),
		);
		expect(FINDINGS_SCHEMAS.documentation.parse(validDocumentation)).toEqual(validDocumentation);
	});
});
