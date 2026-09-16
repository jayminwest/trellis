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

/** A deterministic criterion record with the synthetic-only fields defaulted. */
function criterion(
	id: string,
	category: string,
	scope: "repo" | "app",
): Rubric["criteria"][number] {
	return {
		id,
		category,
		scope,
		level: 2,
		skippable: false,
		discoveryVia: "deterministic",
		investigation: null,
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
		criterion("readme", "documentation", "repo"),
		criterion("adr_presence", "documentation", "repo"),
		criterion("lint_config", "code_quality", "app"),
		criterion("type_check", "code_quality", "app"),
	],
};

/** A two-category rubric with a gate criterion, for the detailed report. */
const GATED_RUBRIC: Rubric = {
	categories: SYNTHETIC_RUBRIC.categories,
	criteria: [
		criterion("readme", "documentation", "repo"),
		criterion("adr_presence", "documentation", "repo"),
		{ ...criterion("lint_config", "code_quality", "app"), gate: true },
		criterion("type_check", "code_quality", "app"),
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
		adr_presence: {
			numerator: null,
			denominator: 1,
			rationale: "no detector bound for this criterion",
			naKind: "no-detector",
		},
		lint_config: { numerator: 2, denominator: 3, rationale: "2/3 apps pass | piped" },
		type_check: {
			numerator: null,
			denominator: 3,
			rationale: "no tsconfig in any app",
			naKind: "not-applicable",
		},
	},
};

/** A report carrying drift + changes-since-last-run, to exercise those sections. */
const RICH_REPORT: Report = {
	...SYNTHETIC_REPORT,
	drift: {
		repo: "sample-repo",
		canonicalVersion: "1.0.0",
		files: [
			{
				path: "biome.json",
				matcher: "json-subset",
				version: "1.0.0",
				state: "drift",
				divergences: [{ path: "linter.rules.style", kind: "changed", detail: "values differ" }],
				allowedBy: [],
			},
			{
				path: "tsconfig.json",
				matcher: "json-subset",
				version: "1.0.0",
				state: "match",
				divergences: [],
				allowedBy: [],
			},
		],
		summary: { match: 1, "allowed-delta": 0, drift: 1, missing: 0, extra: 0 },
	},
	changesSinceLastRun: {
		previousScoredAt: "2026-06-05T00:00:00.000Z",
		previousCommit: "0000000prev",
		previousRubricVersion: "0.2.0",
		previousLevel: 1,
		level: 2,
		netLevelMove: 1,
		rubricVersionChanged: false,
		attribution: "code",
		transitions: [
			{
				criterion: "readme",
				kind: "fail-to-pass",
				before: { status: "fail", numerator: 0, denominator: 1, naKind: null },
				after: { status: "pass", numerator: 1, denominator: 1, naKind: null },
			},
		],
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
		const order = ["readme", "adr_presence", "lint_config", "type_check"].map((id) =>
			json.indexOf(`"${id}"`),
		);
		expect(order).toEqual([...order].sort((a, b) => a - b));
	});

	test("carries the full report including drift and changes-since-last-run", () => {
		const parsed = JSON.parse(renderJson(RICH_REPORT)) as Report;
		expect(parsed.criteria).toBeDefined();
		expect(parsed.drift).toEqual(RICH_REPORT.drift);
		expect(parsed.changesSinceLastRun).toEqual(RICH_REPORT.changesSinceLastRun);
	});
});

describe("renderMarkdown", () => {
	test("matches the golden scorecard", () => {
		const actual = renderMarkdown(RICH_REPORT, GATED_RUBRIC);
		expect(actual).toBe(golden("report.md", actual));
	});

	test("includes the level banner and both apps", () => {
		const md = renderMarkdown(SYNTHETIC_REPORT, SYNTHETIC_RUBRIC);
		expect(md).toContain("Level 2 / 5");
		expect(md).toContain("`.`");
		expect(md).toContain("`src/ui`");
	});

	test("renders every criterion with verdict, score, and rationale", () => {
		const md = renderMarkdown(SYNTHETIC_REPORT, SYNTHETIC_RUBRIC);
		expect(md).toContain("## Criteria");
		expect(md).toContain("| `readme` | pass | 1/1 |");
		expect(md).toContain("| `lint_config` | partial | 2/3 |");
		expect(md).toContain("| `adr_presence` | no-detector | n/a |");
		expect(md).toContain("| `type_check` | not-applicable | n/a |");
		expect(md).toContain("README.md present");
	});

	test("escapes pipe characters in rationale cells", () => {
		const md = renderMarkdown(SYNTHETIC_REPORT, SYNTHETIC_RUBRIC);
		expect(md).toContain("2/3 apps pass \\| piped");
	});

	test("surfaces failing criteria before passing ones within a category", () => {
		const md = renderMarkdown(SYNTHETIC_REPORT, SYNTHETIC_RUBRIC);
		// code_quality: lint_config (partial) must precede type_check (not-applicable).
		expect(md.indexOf("`lint_config`")).toBeLessThan(md.indexOf("`type_check`"));
	});

	test("flags and lists failing gate criteria", () => {
		const md = renderMarkdown(RICH_REPORT, GATED_RUBRIC);
		expect(md).toContain("## Gate criteria failing");
		expect(md).toContain("| `lint_config` | partial (gate) | 2/3 |");
	});

	test("omits the gate section when no gate fails", () => {
		const md = renderMarkdown(SYNTHETIC_REPORT, SYNTHETIC_RUBRIC);
		expect(md).not.toContain("## Gate criteria failing");
	});

	test("renders canonical-config drift when present", () => {
		const md = renderMarkdown(RICH_REPORT, GATED_RUBRIC);
		expect(md).toContain("## Canonical-config drift — `1.0.0`");
		expect(md).toContain("| `biome.json` | drift | 1.0.0 |");
		expect(md).toContain("`linter.rules.style` (changed): values differ");
	});

	test("renders changes-since-last-run when present", () => {
		const md = renderMarkdown(RICH_REPORT, GATED_RUBRIC);
		expect(md).toContain("## Changes since last run");
		expect(md).toContain("Net level move: +1 (attribution: code)");
		expect(md).toContain("| `readme` | fail-to-pass |");
	});

	test("omits drift and changes sections when absent", () => {
		const md = renderMarkdown(SYNTHETIC_REPORT, SYNTHETIC_RUBRIC);
		expect(md).not.toContain("## Canonical-config drift");
		expect(md).not.toContain("## Changes since last run");
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
		// documentation: readme counted (1/1), adr_presence no-detector
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
