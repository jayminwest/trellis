/**
 * The four fixed investigation areas (SPEC §7.1, §9.2).
 *
 * Every agent-graded criterion names exactly one of these areas (the rubric
 * loader enforces it). Each area runs **once per repo** — its findings feed
 * every criterion bound to it — which keeps LLM calls bounded and cacheable
 * (§7.3). An area carries an `id` (matching the rubric's `investigation` field),
 * a human `title`/`description`, the objective `facts` it must gather, and a
 * ready-to-send `prompt` scaffold.
 *
 * The prompt is the contract handed to the bounded Pi run (§9): investigate the
 * area with **read-only** tools, gather **facts, never verdicts** (the pass/fail
 * call is the deterministic grader's, §7.2), then call `submit_findings` exactly
 * once with those facts. The `submit_findings` argument shape is derived from the
 * area's zod schema in `findings.ts`, so the prompt names *what* to gather while
 * the schema fixes *how* it is shaped.
 */

/** The four fixed area ids — identical to the rubric `investigation` field values. */
export const AREA_IDS = [
	"documentation",
	"agent-config",
	"setup-runnability",
	"test-layout",
] as const;

/** One of the four fixed investigation areas. */
export type AreaId = (typeof AREA_IDS)[number];

/** A fixed investigation area: identity, the facts to gather, and the Pi prompt. */
export interface Area {
	readonly id: AreaId;
	/** Short human title. */
	readonly title: string;
	/** What this area covers (one line). */
	readonly description: string;
	/** The objective facts the run must gather — rendered into {@link Area.prompt}. */
	readonly facts: readonly string[];
	/** The full per-area system prompt for the bounded Pi run (§9.2). */
	readonly prompt: string;
}

/**
 * Shared preamble + closing for every area prompt: read-only mandate, the
 * facts-not-verdicts discipline, and the exactly-once `submit_findings` rule.
 * Keeping the framing identical across areas is what makes the only variable the
 * area-specific fact list — so prompt drift can't quietly change one area's
 * behaviour relative to the others.
 */
function buildPrompt(area: {
	title: string;
	description: string;
	facts: readonly string[];
}): string {
	const factLines = area.facts.map((f) => `  - ${f}`).join("\n");
	return [
		`You are auditing one repository for the "${area.title}" area: ${area.description}`,
		"",
		"Use ONLY read-only tools (read files, list directories, inspect git history).",
		"Do not modify the repository, run builds, or execute project code.",
		"",
		"Gather these objective facts:",
		factLines,
		"",
		"Report FACTS, never verdicts: describe what exists, not whether it passes.",
		"Do not score, rate, or judge — a separate deterministic grader decides pass/fail.",
		"When you have gathered the facts, call `submit_findings` EXACTLY ONCE with them,",
		"shaped to match the tool's parameter schema. Call no other tool afterward.",
	].join("\n");
}

/** The four fixed investigation areas, keyed by id. */
export const AREAS: Readonly<Record<AreaId, Area>> = {
	documentation: makeArea({
		id: "documentation",
		title: "Documentation",
		description:
			"prose/docs layout, freshness, build-command presence, runbooks, architecture/flow docs.",
		facts: [
			"Is there a README at the repository root? Does it cover setup and usage?",
			"Is a build command written down anywhere (README, docs, scripts)?",
			"Is there a tool or workflow that generates documentation?",
			"Are operational runbooks present and reachable?",
			"Is a single fresh-clone-to-running-dev-env command documented?",
			"For each key doc (README, AGENTS/CLAUDE, RUNBOOK, CHANGELOG, architecture), how recently was it last modified (days ago, from git history)?",
			"Is there an architecture/flow diagram or dependency documentation?",
		],
	}),
	"agent-config": makeArea({
		id: "agent-config",
		title: "Agent configuration",
		description:
			"the agent-instruction surface (AGENTS.md/CLAUDE.md), skills, validation automation, agent co-authorship.",
		facts: [
			"For each agent-instruction file (AGENTS.md, CLAUDE.md, .cursorrules, etc.): does it document scripts, build/test commands, conventions, and a workflow?",
			"For each skill (a `<name>/SKILL.md`): does it declare a name, a description, and a non-empty prompt body?",
			"What automation keeps the agent instructions honest (CI runs the documented commands, a generator, a pre-commit hook, a doc-command test, a link checker)?",
			"How many commits in git history are co-authored by an agent?",
		],
	}),
	"setup-runnability": makeArea({
		id: "setup-runnability",
		title: "Setup & runnability",
		description:
			"secrets handling, scripted local services, whether the devcontainer would actually build/start.",
		facts: [
			"How are secrets handled (none, an .env-style file, a secret manager, a platform-managed mechanism)? Are any secrets committed to the repo?",
			"Does the project require local services (database, queue, cache)? If so, is a one-shot script provided to start them?",
			"Is a devcontainer configured? If so, what evidence exists that it would actually build/start (absent / unknown / builds / fails)?",
		],
	}),
	"test-layout": makeArea({
		id: "test-layout",
		title: "Test layout",
		description: "where tests live, integration vs unit, naming, isolation, timing/flaky surfaces.",
		facts: [
			"Which directories contain tests? How many unit-test files are there?",
			"Are there integration tests exercising a real boundary (HTTP, DB, filesystem)? Which boundaries?",
			"How many test files are there in total, and how many follow a single consistent naming convention?",
			"Is there a slow-test/timing surface (a timing reporter, a duration budget)?",
			"Do tests run in parallel, and is there evidence of shared mutable state between tests (count the violations)?",
			"Is there retry / quarantine / flaky-reporting handling for flaky tests?",
		],
	}),
};

/** Construct an {@link Area}, rendering its prompt from the shared scaffold. */
function makeArea(spec: {
	id: AreaId;
	title: string;
	description: string;
	facts: readonly string[];
}): Area {
	return { ...spec, prompt: buildPrompt(spec) };
}

/** All four areas as an array, in {@link AREA_IDS} order. */
export const ALL_AREAS: readonly Area[] = AREA_IDS.map((id) => AREAS[id]);

/** Look up an area by id; throws on an unknown id (callers pass rubric-validated ids). */
export function areaById(id: AreaId): Area {
	return AREAS[id];
}
