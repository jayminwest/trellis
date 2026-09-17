/**
 * Catalog tests: assert the authored rubric data (categories.yaml,
 * repo-scope.yaml, app-scope.yaml) matches the transitional catalog exactly.
 *
 * These run the real loader against the real authored YAML (no temp dirs), so
 * a green run is the acceptance gate for the loader: it accepts all three
 * files with zero invariant violations, and the transitional totals (8
 * categories, 30+40=70 criteria, all deterministic, 8 gates one per category)
 * hold. Transitional (SPEC §14 stage 2): the agent-discovery criteria — and
 * the all-agent documentation category — are retired; none may return without
 * re-wiring the investigation pass.
 */
import { describe, expect, test } from "bun:test";
import { loadRubric } from "./loader.ts";

const rubric = loadRubric();

/** The 8 categories, in SPEC §5 order (documentation retired with its all-agent criteria). */
const EXPECTED_CATEGORIES = [
	"code_quality",
	"testing",
	"environment_setup",
	"ci_release_deployment",
	"observability",
	"security_data",
	"process_collaboration",
	"locality_contracts",
] as const;

/** The 8 gate criteria, one per category. */
const EXPECTED_GATES = [
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

	test("declares exactly the 8 transitional categories", () => {
		expect(rubric.categories.map((c) => c.id)).toEqual([...EXPECTED_CATEGORIES]);
	});

	test("totals 70 criteria: 30 repo-scope + 40 app-scope", () => {
		const repo = rubric.criteria.filter((c) => c.scope === "repo");
		const app = rubric.criteria.filter((c) => c.scope === "app");
		expect(repo).toHaveLength(30);
		expect(app).toHaveLength(40);
		expect(rubric.criteria).toHaveLength(70);
	});

	test("is deterministic-only — no agent criteria remain (SPEC §14 stage 2)", () => {
		const agent = rubric.criteria.filter((c) => c.discoveryVia === "agent");
		expect(agent).toHaveLength(0);
		expect(rubric.criteria.every((c) => c.investigation === null)).toBe(true);
	});

	test("carries exactly the 8 gates, one per category", () => {
		const gates = rubric.criteria.filter((c) => c.gate);
		expect(gates.map((c) => c.id).sort()).toEqual([...EXPECTED_GATES].sort());

		const gateCategories = gates.map((c) => c.category).sort();
		expect(gateCategories).toEqual([...EXPECTED_CATEGORIES].sort());
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
