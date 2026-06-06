import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Rubric } from "../rubric/index.ts";
import { renderJson } from "./json.ts";
import { renderMarkdown } from "./markdown.ts";
import { rollupByCategory, tally } from "./rollup.ts";
import { renderTerminal } from "./terminal.ts";
import type { Report } from "./types.ts";

/**
 * Golden-snapshot the renderers against a hand-built synthetic scorecard — a
 * report exercising every disposition (pass, fail, app-scope partial pass,
 * not-applicable, no-detector). Set `TRELLIS_UPDATE_REPORT_GOLDEN=1` to
 * regenerate the `__golden__/` files after an intentional shape change.
 */

const GOLDEN_DIR = join(import.meta.dir, "__golden__");
const UPDATE = process.env.TRELLIS_UPDATE_REPORT_GOLDEN === "1";

/** A criterion record with the synthetic-only fields defaulted. */
function criterion(
	id: string,
	category: string,
	scope: "repo" | "app",
	discoveryVia: "deterministic" | "agent",
): Rubric["criteria"][number] {
	return {
		id,
		category,
		scope,
		level: 2,
		skippable: false,
		discoveryVia,
		investigation: discoveryVia === "agent" ? "documentation" : null,
		gate: false,
		weight: 1,
	};
}

/** A two-category rubric matching the synthetic report below. */
const SYNTHETIC_RUBRIC: Rubric = {
	categories: [
		{ id: "documentation", title: "Documentation", description: "docs scope" },
		{ id: "code_quality", title: "Code Quality", description: "quality scope" },
	],
	criteria: [
		criterion("readme", "documentation", "repo", "deterministic"),
		criterion("agents_md", "documentation", "repo", "agent"),
		criterion("lint_config", "code_quality", "app", "deterministic"),
		criterion("type_check", "code_quality", "app", "deterministic"),
	],
};

/** A synthetic §6.3 report with fixed `scoredAt`/`commit` for byte-stable goldens. */
const SYNTHETIC_REPORT: Report = {
	repo: "sample-repo",
	rubricVersion: "0.2.0",
	scoredAt: "2026-06-06T00:00:00.000Z",
	commit: "abc1234def5678",
	level: 2,
	passRate: 0.5,
	coverage: 0.75,
	apps: {
		".": { description: "server" },
		"src/ui": { description: "sample-ui" },
	},
	criteria: {
		readme: { numerator: 1, denominator: 1, rationale: "README.md present" },
		agents_md: {
			numerator: null,
			denominator: 1,
			rationale: "investigation layer not yet wired",
			naKind: "no-detector",
		},
		lint_config: { numerator: 2, denominator: 3, rationale: "2/3 apps pass" },
		type_check: {
			numerator: null,
			denominator: 3,
			rationale: "no tsconfig in any app",
			naKind: "not-applicable",
		},
	},
};

/** Read a golden file, or write it first when running under the update gate. */
function golden(name: string, actual: string): string {
	const path = join(GOLDEN_DIR, name);
	if (UPDATE) writeFileSync(path, actual);
	return readFileSync(path, "utf8");
}

describe("renderJson", () => {
	test("matches the golden §6.3 document", () => {
		const actual = renderJson(SYNTHETIC_REPORT);
		expect(actual).toBe(golden("report.json", actual));
	});

	test("is byte-identical across repeated renders (determinism)", () => {
		expect(renderJson(SYNTHETIC_REPORT)).toBe(renderJson(SYNTHETIC_REPORT));
	});

	test("emits criteria in rubric (insertion) order", () => {
		const json = renderJson(SYNTHETIC_REPORT);
		const order = ["readme", "agents_md", "lint_config", "type_check"].map((id) =>
			json.indexOf(`"${id}"`),
		);
		expect(order).toEqual([...order].sort((a, b) => a - b));
	});
});

describe("renderMarkdown", () => {
	test("matches the golden scorecard", () => {
		const actual = renderMarkdown(SYNTHETIC_REPORT, SYNTHETIC_RUBRIC);
		expect(actual).toBe(golden("report.md", actual));
	});

	test("includes the level banner and both apps", () => {
		const md = renderMarkdown(SYNTHETIC_REPORT, SYNTHETIC_RUBRIC);
		expect(md).toContain("Level 2 / 5");
		expect(md).toContain("`.`");
		expect(md).toContain("`src/ui`");
	});
});

describe("renderTerminal", () => {
	test("matches the golden scorecard", () => {
		const actual = renderTerminal(SYNTHETIC_REPORT, SYNTHETIC_RUBRIC);
		expect(actual).toBe(golden("report.txt", actual));
	});
});

describe("rollupByCategory", () => {
	test("folds each category's dispositions in rubric order", () => {
		const rollups = rollupByCategory(SYNTHETIC_REPORT, SYNTHETIC_RUBRIC);
		expect(rollups.map((c) => c.id)).toEqual(["documentation", "code_quality"]);
		const [docs, quality] = rollups;
		// documentation: readme counted (1/1), agents_md no-detector
		expect(docs).toMatchObject({ counted: 1, noDetector: 1, passSum: 1, passRate: 1 });
		// code_quality: lint_config counted (2/3), type_check not-applicable
		expect(quality).toMatchObject({ counted: 1, notApplicable: 1 });
		expect(quality?.passRate).toBeCloseTo(2 / 3);
	});
});

describe("tally", () => {
	test("counts the whole-run dispositions", () => {
		expect(tally(SYNTHETIC_REPORT)).toEqual({
			total: 4,
			counted: 2,
			noDetector: 1,
			notApplicable: 1,
			skipped: 0,
		});
	});
});
