/**
 * Deterministic grader (SPEC §7.2) — facts → pass/fail/N-A, pure and total.
 *
 * For each of the 20 agent-graded criteria, a function maps the bound area's
 * validated {@link AreaFindings} to a {@link Grade}. The contract is the whole
 * point of the investigation seam: **same facts → same grade, byte-identical
 * rationale.** No I/O, no clock, no randomness — only the facts in.
 *
 * §3.2 disciplines, enforced structurally:
 * - **Non-skippable criteria can never be N/A.** If evidence is ambiguous they
 *   FAIL. {@link gradeArea}/{@link gradeCriterion} assert this and throw on a
 *   violation, so a grader bug surfaces as a crash, never a silent false N/A.
 * - **Skippable criteria** return `not-applicable` when the surface is honestly
 *   absent (excluded from coverage) or `no-detector` when trellis should have
 *   measured but the facts are ambiguous (counted against coverage).
 *
 * The {@link Grade} shape mirrors the detector layer's `DetectorResult` and the
 * scorer's `ScorecardEntry` (denominator = 1 per unit; `naKind` present iff
 * `numerator` is null) so a graded agent criterion folds into the scorecard on
 * the exact same path as a deterministic one.
 */
import { MAX_RATIONALE, type NaKind } from "../scoring/index.ts";
import type { AreaId } from "./areas.ts";
import {
	type AgentConfigFindings,
	type AreaFindings,
	type DocumentationFindings,
	FINDINGS_SCHEMAS,
	type SetupRunnabilityFindings,
	type TestLayoutFindings,
} from "./findings.ts";

/**
 * One criterion's grade for one unit (SPEC §6.2 / §8.1 shape). `denominator` is
 * always `1` (the per-unit measure; the scorer's aggregator rolls app-scope up to
 * N). `numerator` is `1`/`0`/`null`; `naKind` is present exactly when null.
 */
export interface Grade {
	readonly numerator: number | null;
	readonly denominator: 1;
	readonly naKind?: NaKind;
	readonly rationale: string;
}

/** Key docs are "fresh" if touched within this many days (SPEC §5.1 freshness). */
export const FRESH_THRESHOLD_DAYS = 180;

/** The three skippable agent criteria (rubric `skippable: true`) — the only ones that may grade N/A. */
export const SKIPPABLE_AGENT_CRITERIA: ReadonlySet<string> = new Set([
	"local_services_setup",
	"devcontainer_runnable",
	"flaky_test_detection",
]);

// --- grade builders (mirror the detector helpers; single rationale cap) -------

function clampRationale(rationale: string): string {
	if (rationale.length <= MAX_RATIONALE) return rationale;
	return `${rationale.slice(0, MAX_RATIONALE - 1)}…`;
}

/** A passing grade (`numerator: 1`). */
function gPass(rationale: string): Grade {
	return { numerator: 1, denominator: 1, rationale: clampRationale(rationale) };
}

/** A failing grade (`numerator: 0`). */
function gFail(rationale: string): Grade {
	return { numerator: 0, denominator: 1, rationale: clampRationale(rationale) };
}

/** Honestly-absent surface — excluded from coverage (skippable criteria only). */
function gNotApplicable(rationale: string): Grade {
	return {
		numerator: null,
		denominator: 1,
		naKind: "not-applicable",
		rationale: clampRationale(rationale),
	};
}

/** Should-have-measured-but-couldn't — counted against coverage (skippable criteria only). */
function gNoDetector(rationale: string): Grade {
	return {
		numerator: null,
		denominator: 1,
		naKind: "no-detector",
		rationale: clampRationale(rationale),
	};
}

// --- documentation area graders ----------------------------------------------

const documentationGraders = {
	readme: (f: DocumentationFindings): Grade => {
		const { present, atRoot, hasSetup, hasUsage } = f.readme;
		if (present && atRoot && hasSetup && hasUsage) {
			return gPass("README at repo root covering setup and usage.");
		}
		const missing: string[] = [];
		if (!present) missing.push("no README");
		else {
			if (!atRoot) missing.push("not at root");
			if (!hasSetup) missing.push("no setup");
			if (!hasUsage) missing.push("no usage");
		}
		return gFail(`README inadequate: ${missing.join(", ")}.`);
	},

	build_cmd_doc: (f: DocumentationFindings): Grade =>
		f.buildCommandDocumented
			? gPass("Build command is written down.")
			: gFail("No build command documented."),

	automated_doc_generation: (f: DocumentationFindings): Grade =>
		f.docGenerationMechanisms.length > 0
			? gPass(`Doc generation: ${f.docGenerationMechanisms.join(", ")}.`)
			: gFail("No documentation-generation tool or workflow."),

	runbooks_documented: (f: DocumentationFindings): Grade =>
		f.runbooks.length > 0
			? gPass(`${f.runbooks.length} runbook(s) reachable.`)
			: gFail("No runbooks found."),

	single_command_setup: (f: DocumentationFindings): Grade =>
		f.singleCommandSetupDocumented
			? gPass("A single fresh-clone → running-dev-env command is documented.")
			: gFail("No single-command setup documented."),

	documentation_freshness: (f: DocumentationFindings): Grade => {
		const fresh = f.keyDocs.filter((d) => d.daysSinceModified <= FRESH_THRESHOLD_DAYS);
		return fresh.length > 0
			? gPass(
					`${fresh.length}/${f.keyDocs.length} key doc(s) modified within ${FRESH_THRESHOLD_DAYS}d.`,
				)
			: gFail(`No key doc modified within ${FRESH_THRESHOLD_DAYS}d (${f.keyDocs.length} checked).`);
	},

	service_flow_documented: (f: DocumentationFindings): Grade =>
		f.architectureDocs.length > 0
			? gPass(`Architecture/flow docs: ${f.architectureDocs.length} file(s).`)
			: gFail("No architecture/flow diagram or dependency docs."),
} satisfies Record<string, (f: DocumentationFindings) => Grade>;

// --- agent-config area graders -----------------------------------------------

const agentConfigGraders = {
	agents_md: (f: AgentConfigFindings): Grade => {
		const full = f.agentInstructionFiles.find(
			(a) => a.hasScripts && a.hasBuildTestCmds && a.hasConventions && a.hasWorkflow,
		);
		return full
			? gPass(
					`Agent-instructions file ${full.path} documents scripts, commands, conventions, and workflow.`,
				)
			: gFail(
					"No agent-instructions file documents all of scripts, commands, conventions, and workflow.",
				);
	},

	skills: (f: AgentConfigFindings): Grade => {
		const valid = f.skills.filter((s) => s.hasName && s.hasDescription && s.promptNonEmpty);
		return valid.length > 0
			? gPass(`${valid.length} valid skill(s) (name + description + non-empty prompt).`)
			: gFail("No skill has all of name, description, and a non-empty prompt.");
	},

	// Presupposes agents_md: without an instruction surface there is nothing to
	// validate, which (non-skippable) is a FAIL, not N/A.
	agents_md_validation: (f: AgentConfigFindings): Grade => {
		if (f.agentInstructionFiles.length === 0) {
			return gFail("No agent-instructions file to validate.");
		}
		return f.validationAutomation.length > 0
			? gPass(`Validation automation: ${f.validationAutomation.join(", ")}.`)
			: gFail("Agent instructions present but no automation keeps them honest.");
	},

	agentic_development: (f: AgentConfigFindings): Grade => {
		const hasSurface = f.agentInstructionFiles.length > 0;
		const coAuthored = f.agentCoAuthorshipCommits > 0;
		if (hasSurface && coAuthored) {
			return gPass(
				`Agent instruction surface present and ${f.agentCoAuthorshipCommits} agent co-authored commit(s).`,
			);
		}
		const missing: string[] = [];
		if (!hasSurface) missing.push("no agent instruction surface");
		if (!coAuthored) missing.push("no agent co-authored commits");
		return gFail(`Agents do not actively participate: ${missing.join(", ")}.`);
	},
} satisfies Record<string, (f: AgentConfigFindings) => Grade>;

// --- setup-runnability area graders ------------------------------------------

const setupRunnabilityGraders = {
	secrets_management: (f: SetupRunnabilityFindings): Grade => {
		if (f.committedSecretsFound) return gFail("Secrets are committed to the repository.");
		return f.secretsMechanism !== "none"
			? gPass(`Secrets via ${f.secretsMechanism}, none committed.`)
			: gFail("No managed secrets mechanism.");
	},

	// Skippable: N/A when the project needs no local services at all.
	local_services_setup: (f: SetupRunnabilityFindings): Grade => {
		if (!f.localServicesRequired) return gNotApplicable("Project requires no local services.");
		return f.localServicesScripted
			? gPass("Local services provisioned by a one-shot script.")
			: gFail("Local services required but no scripted setup.");
	},

	// Skippable, presupposes devcontainer: N/A when none is present; ambiguous
	// buildability is no-detector (counted against coverage), not a false pass.
	devcontainer_runnable: (f: SetupRunnabilityFindings): Grade => {
		if (!f.devcontainerPresent) return gNotApplicable("No devcontainer configured.");
		switch (f.devcontainerBuildEvidence) {
			case "builds":
				return gPass("Devcontainer has evidence it builds/starts.");
			case "fails":
				return gFail("Devcontainer is present but fails to build/start.");
			default:
				return gNoDetector("Devcontainer present but buildability could not be determined.");
		}
	},
} satisfies Record<string, (f: SetupRunnabilityFindings) => Grade>;

// --- test-layout area graders (app-scope) ------------------------------------

const testLayoutGraders = {
	unit_tests_exist: (f: TestLayoutFindings): Grade =>
		f.unitTestFiles > 0
			? gPass(`${f.unitTestFiles} unit-test file(s) present.`)
			: gFail("No unit-test files found."),

	integration_tests_exist: (f: TestLayoutFindings): Grade =>
		f.integrationTests.present && f.integrationTests.boundaries.length > 0
			? gPass(`Integration tests cross: ${f.integrationTests.boundaries.join(", ")}.`)
			: gFail("No integration tests across a real boundary."),

	test_naming_conventions: (f: TestLayoutFindings): Grade => {
		if (f.testFileCount === 0) return gFail("No test files to assess naming.");
		return f.testFilesMatchingConvention === f.testFileCount
			? gPass(`All ${f.testFileCount} test file(s) follow one naming convention.`)
			: gFail(
					`${f.testFilesMatchingConvention}/${f.testFileCount} test files follow the naming convention.`,
				);
	},

	test_performance_tracking: (f: TestLayoutFindings): Grade =>
		f.timingSurface
			? gPass("A slow-test/timing surface exists.")
			: gFail("No slow-test or timing surface."),

	test_isolation: (f: TestLayoutFindings): Grade => {
		if (f.parallelExecution && f.sharedMutableStateViolations === 0) {
			return gPass("Tests run in parallel with no shared-mutable-state violations.");
		}
		const reasons: string[] = [];
		if (!f.parallelExecution) reasons.push("not parallel-safe");
		if (f.sharedMutableStateViolations > 0) {
			reasons.push(`${f.sharedMutableStateViolations} shared-state violation(s)`);
		}
		return gFail(`Tests not isolated: ${reasons.join(", ")}.`);
	},

	// Skippable: N/A when there are no tests at all (no surface to make flake-safe).
	flaky_test_detection: (f: TestLayoutFindings): Grade => {
		if (f.testFileCount === 0) return gNotApplicable("No tests present.");
		return f.flakyHandling.length > 0
			? gPass(`Flaky handling: ${f.flakyHandling.join(", ")}.`)
			: gFail("Tests present but no retry/quarantine/flaky reporting.");
	},
} satisfies Record<string, (f: TestLayoutFindings) => Grade>;

// --- registry & dispatch -----------------------------------------------------

/** Per-area grader maps. Each criterion id appears under exactly one area. */
const AREA_GRADERS = {
	documentation: documentationGraders,
	"agent-config": agentConfigGraders,
	"setup-runnability": setupRunnabilityGraders,
	"test-layout": testLayoutGraders,
} as const;

/** Criterion id → its bound area id, derived from {@link AREA_GRADERS}. */
export const CRITERION_AREA: Readonly<Record<string, AreaId>> = Object.fromEntries(
	(Object.keys(AREA_GRADERS) as AreaId[]).flatMap((area) =>
		Object.keys(AREA_GRADERS[area]).map((id) => [id, area] as const),
	),
);

/** Every criterion id this grader covers (the 20 agent criteria). */
export function gradedCriterionIds(): readonly string[] {
	return Object.keys(CRITERION_AREA);
}

/**
 * Assert a non-skippable criterion never graded N/A (SPEC §3.2). A violation is
 * a grader bug — fail loudly rather than emit a coverage-distorting false N/A.
 */
function enforceSkippable(criterionId: string, grade: Grade): Grade {
	if (grade.numerator === null && !SKIPPABLE_AGENT_CRITERIA.has(criterionId)) {
		throw new Error(
			`grader bug: non-skippable criterion "${criterionId}" graded N/A (${grade.naKind})`,
		);
	}
	return grade;
}

/**
 * Grade every criterion bound to `area` from one validated findings object
 * (§7.1: an area runs once; its facts feed all its criteria). `findings` is
 * parsed against the area schema first, so malformed/verdict-shaped facts throw
 * before any criterion is graded.
 */
export function gradeArea<A extends AreaId>(area: A, findings: unknown): Map<string, Grade> {
	const parsed = FINDINGS_SCHEMAS[area].parse(findings) as AreaFindings[A];
	const graders = AREA_GRADERS[area] as Record<string, (f: AreaFindings[A]) => Grade>;
	const out = new Map<string, Grade>();
	for (const [id, grade] of Object.entries(graders)) {
		out.set(id, enforceSkippable(id, grade(parsed)));
	}
	return out;
}

/**
 * Grade a single criterion from its area's findings. `findings` is validated
 * against the criterion's bound area schema first. Throws on an unknown
 * criterion id (callers pass rubric agent criterion ids).
 */
export function gradeCriterion(criterionId: string, findings: unknown): Grade {
	const area = CRITERION_AREA[criterionId];
	if (area === undefined) throw new Error(`no grader for criterion "${criterionId}"`);
	const parsed = FINDINGS_SCHEMAS[area].parse(findings);
	const graders = AREA_GRADERS[area] as Record<string, (f: unknown) => Grade>;
	const grader = graders[criterionId];
	// Unreachable: CRITERION_AREA was built from these same maps.
	if (grader === undefined) throw new Error(`no grader for criterion "${criterionId}"`);
	return enforceSkippable(criterionId, grader(parsed));
}
