import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadRubric } from "../../rubric/index.ts";
import { createDetectionContext } from "../context.ts";
import type { DetectionContext } from "../types.ts";
import {
	agenticDevelopment,
	agentsMd,
	apiSchemaDocs,
	automatedDocGen,
	checkAllCi,
	checkAllPreCommit,
	checkAllTests,
	codeQualityMetrics,
	deadCode,
	documentationFreshness,
	duplicateCode,
	heavyDeps,
	largeFile,
	OSECO_OVERLAY,
	seedsBacklog,
	seedsIssueTemplates,
	seedsLabeling,
	skills,
	techDebt,
	unusedDeps,
} from "./evidence.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A temp repo seeded with `files`; the os-eco overlay runs at the repo root. */
async function repo(files: Record<string, string>): Promise<DetectionContext> {
	const root = await mkdtemp(join(tmpdir(), "trellis-oseco-"));
	dirs.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(root, rel);
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, content);
	}
	return createDetectionContext(root, { path: ".", languages: ["typescript"] });
}

describe("agentsMd evidence", () => {
	test("passes naming both files when AGENTS.md + CLAUDE.md present", async () => {
		const r = await agentsMd(await repo({ "AGENTS.md": "# A\n", "CLAUDE.md": "# C\n" }));
		expect(r.numerator).toBe(1);
		expect(r.rationale).toContain("CLAUDE.md");
	});

	test("passes on AGENTS.md alone", async () => {
		expect((await agentsMd(await repo({ "AGENTS.md": "# A\n" }))).numerator).toBe(1);
	});

	test("no evidence (not-applicable) without AGENTS.md", async () => {
		const r = await agentsMd(await repo({ "README.md": "x" }));
		expect(r.numerator).toBeNull();
		expect(r.naKind).toBe("not-applicable");
	});
});

describe("skills evidence", () => {
	test("passes on a nested SKILL.md", async () => {
		expect((await skills(await repo({ ".factory/skills/x/SKILL.md": "y" }))).numerator).toBe(1);
	});
	test("no evidence without any SKILL.md", async () => {
		expect((await skills(await repo({}))).numerator).toBeNull();
	});
});

describe("seeds evidence", () => {
	test("issue_templates passes when .seeds/ present", async () => {
		expect((await seedsIssueTemplates(await repo({ ".seeds/config.toml": "x" }))).numerator).toBe(
			1,
		);
	});
	test("labeling names the config file", async () => {
		const r = await seedsLabeling(await repo({ ".seeds/config.toml": "labels = []" }));
		expect(r.numerator).toBe(1);
		expect(r.rationale).toContain("config.toml");
	});
	test("backlog passes with issue records present", async () => {
		expect((await seedsBacklog(await repo({ ".seeds/issues/a.json": "{}" }))).numerator).toBe(1);
	});
	test("seeds detectors are not-applicable without .seeds/", async () => {
		expect((await seedsIssueTemplates(await repo({}))).numerator).toBeNull();
		expect((await seedsLabeling(await repo({}))).numerator).toBeNull();
		expect((await seedsBacklog(await repo({}))).numerator).toBeNull();
	});
});

describe("ratchet evidence", () => {
	test("largeFile passes via a check:file-size script", async () => {
		const ctx = await repo({ "package.json": '{"scripts":{"check:file-size":"x"}}' });
		expect((await largeFile(ctx)).numerator).toBe(1);
	});
	test("techDebt passes via a committed budget file", async () => {
		expect(
			(await techDebt(await repo({ "scripts/debt-markers-budget.json": "{}" }))).numerator,
		).toBe(1);
	});
	test("codeQualityMetrics passes via a check:quality script", async () => {
		expect(
			(
				await codeQualityMetrics(
					await repo({ "package.json": '{"scripts":{"check:quality":"x"}}' }),
				)
			).numerator,
		).toBe(1);
	});
	test("deadCode + unusedDeps pass via knip.json", async () => {
		const ctx = await repo({ "knip.json": "{}" });
		expect((await deadCode(ctx)).numerator).toBe(1);
		expect((await unusedDeps(ctx)).numerator).toBe(1);
	});
	test("duplicateCode passes via .jscpd.json", async () => {
		expect((await duplicateCode(await repo({ ".jscpd.json": "{}" }))).numerator).toBe(1);
	});
	test("heavyDeps passes via a check:bundle script", async () => {
		expect(
			(await heavyDeps(await repo({ "package.json": '{"scripts":{"check:bundle":"x"}}' })))
				.numerator,
		).toBe(1);
	});
	test("ratchet detectors are not-applicable when absent", async () => {
		expect((await largeFile(await repo({ "package.json": "{}" }))).numerator).toBeNull();
		expect((await deadCode(await repo({}))).numerator).toBeNull();
	});
});

describe("check:all evidence", () => {
	const pkg = (scripts: Record<string, string>) => JSON.stringify({ scripts });

	test("checkAllTests passes on a bun test script, not-applicable otherwise", async () => {
		expect(
			(await checkAllTests(await repo({ "package.json": pkg({ test: "bun test" }) }))).numerator,
		).toBe(1);
		expect((await checkAllTests(await repo({ "package.json": "{}" }))).numerator).toBeNull();
	});

	test("checkAllPreCommit needs both the gate and a committed hook", async () => {
		const gateOnly = await repo({ "package.json": pkg({ "check:all": "x" }) });
		expect((await checkAllPreCommit(gateOnly)).numerator).toBeNull();
		const both = await repo({
			"package.json": pkg({ "check:all": "x" }),
			".githooks/pre-commit": "bun run check:all",
		});
		expect((await checkAllPreCommit(both)).numerator).toBe(1);
	});

	test("checkAllCi needs the gate run in a workflow", async () => {
		const gateOnly = await repo({ "package.json": pkg({ "check:all": "x" }) });
		expect((await checkAllCi(gateOnly)).numerator).toBeNull();
		const inCi = await repo({
			"package.json": pkg({ "check:all": "x" }),
			".github/workflows/ci.yml": "steps:\n  - run: bun run check:all\n",
		});
		expect((await checkAllCi(inCi)).numerator).toBe(1);
	});
});

describe("docs evidence", () => {
	test("apiSchemaDocs passes via docs/openapi.yaml", async () => {
		expect((await apiSchemaDocs(await repo({ "docs/openapi.yaml": "openapi: 3" }))).numerator).toBe(
			1,
		);
	});
	test("automatedDocGen passes via .canopy/", async () => {
		expect((await automatedDocGen(await repo({ ".canopy/prompts/x.md": "y" }))).numerator).toBe(1);
	});
	test("automatedDocGen passes via a gen:docs script", async () => {
		expect(
			(await automatedDocGen(await repo({ "package.json": '{"scripts":{"gen:docs":"x"}}' })))
				.numerator,
		).toBe(1);
	});
	test("documentationFreshness passes via .mulch/", async () => {
		expect(
			(await documentationFreshness(await repo({ ".mulch/records/x.json": "{}" }))).numerator,
		).toBe(1);
	});
});

describe("agenticDevelopment evidence", () => {
	test("passes via .mulch/", async () => {
		expect((await agenticDevelopment(await repo({ ".mulch/x.json": "{}" }))).numerator).toBe(1);
	});
	test("passes via .plot/", async () => {
		expect((await agenticDevelopment(await repo({ ".plot/x.json": "{}" }))).numerator).toBe(1);
	});
	test("not-applicable for a non-git repo without .mulch/.plot", async () => {
		expect((await agenticDevelopment(await repo({}))).numerator).toBeNull();
	});
});

describe("OSECO_OVERLAY map", () => {
	test("every key is a current or retired (SPEC §14 stage 2) rubric criterion id", () => {
		// The overlay is unwired from the audit pipeline (stage 2) and leaves with
		// the investigation subsystem (stage 3); keys naming retired agent
		// criteria are expected until then.
		const RETIRED = new Set([
			"agents_md",
			"skills",
			"automated_doc_generation",
			"documentation_freshness",
			"agentic_development",
		]);
		const ids = new Set(loadRubric().criteria.map((c) => c.id));
		for (const id of Object.keys(OSECO_OVERLAY)) {
			expect(ids.has(id) || RETIRED.has(id)).toBe(true);
		}
	});

	test("covers the SPEC §8.4 mapped criteria", () => {
		for (const id of [
			"agents_md",
			"skills",
			"issue_templates",
			"issue_labeling_system",
			"backlog_health",
			"unit_tests_runnable",
			"pre_commit_hooks",
			"fast_ci_feedback",
			"large_file_detection",
			"tech_debt_tracking",
			"code_quality_metrics",
			"dead_code_detection",
			"duplicate_code_detection",
			"unused_dependencies_detection",
			"heavy_dependency_detection",
			"api_schema_docs",
			"automated_doc_generation",
			"documentation_freshness",
			"agentic_development",
		]) {
			expect(OSECO_OVERLAY[id]).toBeDefined();
		}
	});
});
