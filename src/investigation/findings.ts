/**
 * Findings contracts (SPEC §7.2) — one zod schema per investigation area.
 *
 * Each area's bounded Pi run returns a **facts** object that must validate
 * against the matching schema here; the deterministic grader (`grader.ts`)
 * decides pass/fail from those facts. The discipline: these schemas capture
 * **objective facts only — never verdicts**. Every object is `z.strictObject`,
 * so a run that smuggles in a verdict-shaped extra (`passed`, `score`,
 * `verdict`, …) is **rejected at the boundary** rather than silently graded.
 *
 * The `submit_findings` tool's JSON-schema is derived from these via
 * `zod-to-json-schema` (§9.2), so Pi is shown exactly the fact shape it must
 * return. Field names mirror the `Area.facts` prompts in `areas.ts`.
 */
import { z } from "zod";
import type { AreaId } from "./areas.ts";

/** Facts for the `documentation` area. */
export const documentationFindingsSchema = z.strictObject({
	/** The root README and what it covers. */
	readme: z.strictObject({
		present: z.boolean(),
		atRoot: z.boolean(),
		hasSetup: z.boolean(),
		hasUsage: z.boolean(),
	}),
	/** A build command is written down (README, docs, or a script). */
	buildCommandDocumented: z.boolean(),
	/** Mechanisms that generate documentation (e.g. a doc generator, a CI docs job). */
	docGenerationMechanisms: z.array(z.string()),
	/** Reachable operational runbooks (paths). */
	runbooks: z.array(z.string()),
	/** A one-shot fresh-clone → running-dev-env command is documented. */
	singleCommandSetupDocumented: z.boolean(),
	/** Key docs with how recently each was last modified (days ago, from git). */
	keyDocs: z.array(
		z.strictObject({
			path: z.string(),
			daysSinceModified: z.number().int().nonnegative(),
		}),
	),
	/** Architecture/flow diagrams or dependency docs (paths). */
	architectureDocs: z.array(z.string()),
});
export type DocumentationFindings = z.infer<typeof documentationFindingsSchema>;

/** The kinds of agents-instructions validation automation we recognise (§7.2). */
export const VALIDATION_AUTOMATION = [
	"ci-runs-commands",
	"generator",
	"pre-commit",
	"doc-cmd-test",
	"link-checker",
] as const;

/** Facts for the `agent-config` area (the §7.2 shape model, finalized). */
export const agentConfigFindingsSchema = z.strictObject({
	/** Each agent-instruction file and which sections it carries. */
	agentInstructionFiles: z.array(
		z.strictObject({
			path: z.string(),
			hasScripts: z.boolean(),
			hasBuildTestCmds: z.boolean(),
			hasConventions: z.boolean(),
			hasWorkflow: z.boolean(),
		}),
	),
	/** Each skill (`<name>/SKILL.md`) and whether its parts are populated. */
	skills: z.array(
		z.strictObject({
			dir: z.string(),
			hasName: z.boolean(),
			hasDescription: z.boolean(),
			promptNonEmpty: z.boolean(),
		}),
	),
	/** Automation that keeps the agent instructions honest. */
	validationAutomation: z.array(z.enum(VALIDATION_AUTOMATION)),
	/** Count of commits co-authored by an agent. */
	agentCoAuthorshipCommits: z.number().int().nonnegative(),
});
export type AgentConfigFindings = z.infer<typeof agentConfigFindingsSchema>;

/** How secrets are supplied to the project. */
export const SECRETS_MECHANISM = [
	"none",
	"env-file",
	"secret-manager",
	"platform-managed",
] as const;

/** Evidence that a devcontainer would actually build/start. */
export const DEVCONTAINER_BUILD_EVIDENCE = ["absent", "unknown", "builds", "fails"] as const;

/** Facts for the `setup-runnability` area. */
export const setupRunnabilityFindingsSchema = z.strictObject({
	/** The secrets mechanism in use. */
	secretsMechanism: z.enum(SECRETS_MECHANISM),
	/** A secret (key, token, credential) is committed to the repo. */
	committedSecretsFound: z.boolean(),
	/** The project depends on local services (DB, queue, cache) to run. */
	localServicesRequired: z.boolean(),
	/** A one-shot script provisions those local services. */
	localServicesScripted: z.boolean(),
	/** A devcontainer config is present. */
	devcontainerPresent: z.boolean(),
	/** Evidence the devcontainer would build/start. */
	devcontainerBuildEvidence: z.enum(DEVCONTAINER_BUILD_EVIDENCE),
});
export type SetupRunnabilityFindings = z.infer<typeof setupRunnabilityFindingsSchema>;

/** Boundaries an integration test may cross. */
export const INTEGRATION_BOUNDARIES = [
	"http",
	"db",
	"filesystem",
	"process",
	"network",
	"queue",
] as const;

/** Flaky-test handling mechanisms. */
export const FLAKY_HANDLING = ["retry", "quarantine", "reporting"] as const;

/** Facts for the `test-layout` area (app-scope). */
export const testLayoutFindingsSchema = z
	.strictObject({
		/** Directories that contain tests. */
		testDirs: z.array(z.string()),
		/** Number of unit-test files. */
		unitTestFiles: z.number().int().nonnegative(),
		/** Integration tests crossing a real boundary. */
		integrationTests: z.strictObject({
			present: z.boolean(),
			boundaries: z.array(z.enum(INTEGRATION_BOUNDARIES)),
		}),
		/** Total test files, and how many follow one consistent naming convention. */
		testFileCount: z.number().int().nonnegative(),
		testFilesMatchingConvention: z.number().int().nonnegative(),
		/** A slow-test/timing surface exists (timing reporter, duration budget). */
		timingSurface: z.boolean(),
		/** Tests run in parallel. */
		parallelExecution: z.boolean(),
		/** Count of shared-mutable-state violations observed between tests. */
		sharedMutableStateViolations: z.number().int().nonnegative(),
		/** Flaky-test handling mechanisms present. */
		flakyHandling: z.array(z.enum(FLAKY_HANDLING)),
	})
	.superRefine((f, ctx) => {
		// A fact-sanity invariant: you cannot have more convention-matching files
		// than files. A run that reports otherwise is malformed, not just wrong.
		if (f.testFilesMatchingConvention > f.testFileCount) {
			ctx.addIssue({
				code: "custom",
				message: "testFilesMatchingConvention must not exceed testFileCount",
				path: ["testFilesMatchingConvention"],
			});
		}
	});
export type TestLayoutFindings = z.infer<typeof testLayoutFindingsSchema>;

/** Per-area findings schema, keyed by area id. */
export const FINDINGS_SCHEMAS = {
	documentation: documentationFindingsSchema,
	"agent-config": agentConfigFindingsSchema,
	"setup-runnability": setupRunnabilityFindingsSchema,
	"test-layout": testLayoutFindingsSchema,
} as const satisfies Record<AreaId, z.ZodType>;

/** The validated findings type for a given area id. */
export type AreaFindings = {
	documentation: DocumentationFindings;
	"agent-config": AgentConfigFindings;
	"setup-runnability": SetupRunnabilityFindings;
	"test-layout": TestLayoutFindings;
};
