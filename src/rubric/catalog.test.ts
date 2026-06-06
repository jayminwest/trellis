/**
 * Catalog tests: assert the authored rubric data (categories.yaml,
 * repo-scope.yaml, app-scope.yaml) matches the SPEC §5 catalog exactly.
 *
 * These run the real loader against the real authored YAML (no temp dirs), so
 * a green run is the acceptance gate for trellis-db3d: the step-5 loader
 * accepts all three files with zero invariant violations, and the catalog
 * totals (9 categories, 44+46=90 criteria, 70 det / 20 agent, 9 gates one per
 * category) hold.
 */
import { describe, expect, test } from "bun:test";
import { loadRubric } from "./loader.ts";
import { INVESTIGATION_AREAS, type InvestigationArea } from "./schema.ts";

/** Widened so `toContain` accepts a nullable `investigation` value. */
const AREAS: readonly (InvestigationArea | null)[] = INVESTIGATION_AREAS;

const rubric = loadRubric();

/** The 9 categories, in SPEC §5 order. */
const EXPECTED_CATEGORIES = [
	"documentation",
	"code_quality",
	"testing",
	"environment_setup",
	"ci_release_deployment",
	"observability",
	"security_data",
	"process_collaboration",
	"locality_contracts",
] as const;

/** The 9 gate criteria (SPEC §5), one per category. */
const EXPECTED_GATES = [
	"single_command_setup",
	"type_check",
	"unit_tests_runnable",
	"deps_pinned",
	"vcs_cli_tools",
	"structured_logging",
	"log_scrubbing",
	"codeowners",
	"import_cycle_detection",
] as const;

describe("rubric catalog", () => {
	test("loads all three files with zero invariant violations", () => {
		// loadRubric() above already enforces every load-time invariant; reaching
		// this assertion means it accepted the authored data.
		expect(rubric.categories.length).toBeGreaterThan(0);
		expect(rubric.criteria.length).toBeGreaterThan(0);
	});

	test("declares exactly the 9 §5 categories", () => {
		expect(rubric.categories.map((c) => c.id)).toEqual([...EXPECTED_CATEGORIES]);
	});

	test("totals 90 criteria: 44 repo-scope + 46 app-scope", () => {
		const repo = rubric.criteria.filter((c) => c.scope === "repo");
		const app = rubric.criteria.filter((c) => c.scope === "app");
		expect(repo).toHaveLength(44);
		expect(app).toHaveLength(46);
		expect(rubric.criteria).toHaveLength(90);
	});

	test("splits 70 deterministic / 20 agent", () => {
		const det = rubric.criteria.filter((c) => c.discoveryVia === "deterministic");
		const agent = rubric.criteria.filter((c) => c.discoveryVia === "agent");
		expect(det).toHaveLength(70);
		expect(agent).toHaveLength(20);
	});

	test("carries exactly the 9 gates, one per category", () => {
		const gates = rubric.criteria.filter((c) => c.gate);
		expect(gates.map((c) => c.id).sort()).toEqual([...EXPECTED_GATES].sort());

		const gateCategories = gates.map((c) => c.category).sort();
		expect(gateCategories).toEqual([...EXPECTED_CATEGORIES].sort());
	});

	test("every agent criterion names one of the 4 investigation areas", () => {
		const agent = rubric.criteria.filter((c) => c.discoveryVia === "agent");
		for (const c of agent) {
			expect(c.investigation).not.toBeNull();
			expect(AREAS).toContain(c.investigation);
		}
	});

	test("every deterministic criterion has no investigation area", () => {
		const det = rubric.criteria.filter((c) => c.discoveryVia === "deterministic");
		for (const c of det) {
			expect(c.investigation).toBeNull();
		}
	});

	test("every criterion's category resolves to a declared category", () => {
		const known = new Set(rubric.categories.map((c) => c.id));
		for (const c of rubric.criteria) {
			expect(known.has(c.category)).toBe(true);
		}
	});

	test("every criterion carries a level in 1..5 and default weight 1", () => {
		for (const c of rubric.criteria) {
			expect(c.level).toBeGreaterThanOrEqual(1);
			expect(c.level).toBeLessThanOrEqual(5);
			expect(c.weight).toBe(1);
		}
	});
});
