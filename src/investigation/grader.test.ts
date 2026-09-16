import { describe, expect, test } from "bun:test";
import { loadRubric } from "../rubric/index.ts";
import type {
	AgentConfigFindings,
	DocumentationFindings,
	SetupRunnabilityFindings,
	TestLayoutFindings,
} from "./findings.ts";
import {
	CRITERION_AREA,
	FRESH_THRESHOLD_DAYS,
	type Grade,
	gradeArea,
	gradeCriterion,
	gradedCriterionIds,
	SKIPPABLE_AGENT_CRITERIA,
} from "./grader.ts";

// --- base valid findings; each test overrides only what it exercises ---------

const doc: DocumentationFindings = {
	readme: { present: true, atRoot: true, hasSetup: true, hasUsage: true },
	buildCommandDocumented: true,
	docGenerationMechanisms: ["typedoc"],
	runbooks: ["RUNBOOK.md"],
	singleCommandSetupDocumented: true,
	keyDocs: [{ path: "README.md", daysSinceModified: 5 }],
	architectureDocs: ["docs/architecture.mmd"],
};
const agent: AgentConfigFindings = {
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
	agentCoAuthorshipCommits: 7,
};
const setup: SetupRunnabilityFindings = {
	secretsMechanism: "env-file",
	committedSecretsFound: false,
	localServicesRequired: true,
	localServicesScripted: true,
	devcontainerPresent: true,
	devcontainerBuildEvidence: "builds",
};
const tests: TestLayoutFindings = {
	testDirs: ["src"],
	unitTestFiles: 30,
	integrationTests: { present: true, boundaries: ["db"] },
	testFileCount: 32,
	testFilesMatchingConvention: 32,
	timingSurface: true,
	parallelExecution: true,
	sharedMutableStateViolations: 0,
	flakyHandling: ["retry"],
};

// expectation helpers — outcome of a Grade
const PASS = "pass" as const;
const FAIL = "fail" as const;
const NA = "not-applicable" as const;
const NODET = "no-detector" as const;
type Expected = typeof PASS | typeof FAIL | typeof NA | typeof NODET;

function outcome(g: Grade): Expected {
	if (g.numerator === 1) return PASS;
	if (g.numerator === 0) return FAIL;
	return g.naKind === "not-applicable" ? NA : NODET;
}

/** A grader-table row: criterion id, findings, and the expected outcome. */
type Row = [id: string, findings: unknown, expected: Expected];

const TABLE: Row[] = [
	// --- documentation -------------------------------------------------------
	["readme", doc, PASS],
	["readme", { ...doc, readme: { ...doc.readme, hasUsage: false } }, FAIL],
	["readme", { ...doc, readme: { ...doc.readme, present: false } }, FAIL],
	["build_cmd_doc", doc, PASS],
	["build_cmd_doc", { ...doc, buildCommandDocumented: false }, FAIL],
	["automated_doc_generation", doc, PASS],
	["automated_doc_generation", { ...doc, docGenerationMechanisms: [] }, FAIL],
	["runbooks_documented", doc, PASS],
	["runbooks_documented", { ...doc, runbooks: [] }, FAIL],
	["single_command_setup", doc, PASS],
	["single_command_setup", { ...doc, singleCommandSetupDocumented: false }, FAIL],
	["documentation_freshness", doc, PASS],
	[
		"documentation_freshness",
		{ ...doc, keyDocs: [{ path: "README.md", daysSinceModified: FRESH_THRESHOLD_DAYS + 1 }] },
		FAIL,
	],
	["service_flow_documented", doc, PASS],
	["service_flow_documented", { ...doc, architectureDocs: [] }, FAIL],

	// --- agent-config --------------------------------------------------------
	["agents_md", agent, PASS],
	[
		"agents_md",
		{
			...agent,
			agentInstructionFiles: [{ ...agent.agentInstructionFiles[0], hasWorkflow: false }],
		},
		FAIL,
	],
	["agents_md", { ...agent, agentInstructionFiles: [] }, FAIL],
	["skills", agent, PASS],
	[
		"skills",
		{
			...agent,
			skills: [{ dir: "s", hasName: true, hasDescription: true, promptNonEmpty: false }],
		},
		FAIL,
	],
	["skills", { ...agent, skills: [] }, FAIL],
	["agents_md_validation", agent, PASS],
	["agents_md_validation", { ...agent, validationAutomation: [] }, FAIL],
	["agents_md_validation", { ...agent, agentInstructionFiles: [], validationAutomation: [] }, FAIL],
	["agentic_development", agent, PASS],
	["agentic_development", { ...agent, agentCoAuthorshipCommits: 0 }, FAIL],
	["agentic_development", { ...agent, agentInstructionFiles: [] }, FAIL],

	// --- setup-runnability ---------------------------------------------------
	["secrets_management", setup, PASS],
	["secrets_management", { ...setup, secretsMechanism: "none" }, FAIL],
	["secrets_management", { ...setup, committedSecretsFound: true }, FAIL],
	["local_services_setup", setup, PASS],
	["local_services_setup", { ...setup, localServicesScripted: false }, FAIL],
	["local_services_setup", { ...setup, localServicesRequired: false }, NA],
	["devcontainer_runnable", setup, PASS],
	["devcontainer_runnable", { ...setup, devcontainerBuildEvidence: "fails" }, FAIL],
	["devcontainer_runnable", { ...setup, devcontainerBuildEvidence: "unknown" }, NODET],
	[
		"devcontainer_runnable",
		{ ...setup, devcontainerPresent: false, devcontainerBuildEvidence: "absent" },
		NA,
	],

	// --- test-layout ---------------------------------------------------------
	["unit_tests_exist", tests, PASS],
	["unit_tests_exist", { ...tests, unitTestFiles: 0 }, FAIL],
	["integration_tests_exist", tests, PASS],
	[
		"integration_tests_exist",
		{ ...tests, integrationTests: { present: false, boundaries: [] } },
		FAIL,
	],
	["test_naming_conventions", tests, PASS],
	["test_naming_conventions", { ...tests, testFilesMatchingConvention: 30 }, FAIL],
	["test_naming_conventions", { ...tests, testFileCount: 0, testFilesMatchingConvention: 0 }, FAIL],
	["test_performance_tracking", tests, PASS],
	["test_performance_tracking", { ...tests, timingSurface: false }, FAIL],
	["test_isolation", tests, PASS],
	["test_isolation", { ...tests, sharedMutableStateViolations: 3 }, FAIL],
	["test_isolation", { ...tests, parallelExecution: false }, FAIL],
	["flaky_test_detection", tests, PASS],
	["flaky_test_detection", { ...tests, flakyHandling: [] }, FAIL],
	[
		"flaky_test_detection",
		{ ...tests, testFileCount: 0, testFilesMatchingConvention: 0, unitTestFiles: 0 },
		NA,
	],
];

describe("grader table (facts → grade)", () => {
	for (const [id, findings, expected] of TABLE) {
		test(`${id} → ${expected}`, () => {
			expect(outcome(gradeCriterion(id, findings))).toBe(expected);
		});
	}

	test("every grade carries a non-empty rationale and denominator 1", () => {
		for (const [id, findings] of TABLE) {
			const g = gradeCriterion(id, findings);
			expect(g.denominator).toBe(1);
			expect(g.rationale.length).toBeGreaterThan(0);
		}
	});

	test("naKind is present exactly when numerator is null", () => {
		for (const [id, findings] of TABLE) {
			const g = gradeCriterion(id, findings);
			expect(g.naKind !== undefined).toBe(g.numerator === null);
		}
	});
});

describe("determinism", () => {
	test("same facts → byte-identical grade and rationale", () => {
		for (const [id, findings] of TABLE) {
			expect(gradeCriterion(id, findings)).toEqual(gradeCriterion(id, findings));
		}
	});
});

describe("§3.2 skippable discipline", () => {
	test("only skippable criteria ever grade N/A", () => {
		for (const [id, findings] of TABLE) {
			const g = gradeCriterion(id, findings);
			if (g.numerator === null) expect(SKIPPABLE_AGENT_CRITERIA.has(id)).toBe(true);
		}
	});

	test("the skippable set is exactly the three rubric skippable agent criteria", () => {
		expect([...SKIPPABLE_AGENT_CRITERIA].sort()).toEqual(
			["devcontainer_runnable", "flaky_test_detection", "local_services_setup"].sort(),
		);
	});
});

describe("schema validation at the grader boundary", () => {
	test("gradeCriterion rejects verdict-shaped findings", () => {
		expect(() => gradeCriterion("readme", { ...doc, passed: true })).toThrow();
	});
	test("gradeArea rejects verdict-shaped findings before grading", () => {
		expect(() => gradeArea("agent-config", { ...agent, verdict: "pass" })).toThrow();
	});
	test("gradeCriterion throws on an unknown criterion id", () => {
		expect(() => gradeCriterion("not_a_criterion", doc)).toThrow();
	});
});

describe("gradeArea", () => {
	test("grades every criterion bound to an area in one pass", () => {
		const grades = gradeArea("documentation", doc);
		const expectedIds = Object.entries(CRITERION_AREA)
			.filter(([, area]) => area === "documentation")
			.map(([id]) => id);
		expect([...grades.keys()].sort()).toEqual(expectedIds.sort());
		for (const g of grades.values()) expect(g.numerator).toBe(1);
	});
});

describe("retired agent criteria (SPEC §14 stage 2)", () => {
	const rubric = loadRubric();

	test("the transitional catalog carries no agent criteria for the grader to cover", () => {
		// The investigation pass is disconnected and this subsystem leaves with
		// stage 3; the grader's 20 legacy ids are all retired from the catalog.
		expect(rubric.criteria.filter((c) => c.discoveryVia === "agent")).toHaveLength(0);
		expect(gradedCriterionIds()).toHaveLength(20);
		for (const id of gradedCriterionIds()) {
			expect(rubric.criteria.some((c) => c.id === id)).toBe(false);
		}
	});
});
