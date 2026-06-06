import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRubric, RUBRIC_VERSION } from "../rubric/index.ts";
import { AGENT_NOT_WIRED, auditRepo } from "./build.ts";
import { renderJson } from "./json.ts";

/**
 * End-to-end det-only audit against a small fixture repo: discovery → registry →
 * detectors → scoring → §6.3 report. Covers the determinism acceptance (byte-
 * identical JSON across two runs of the same checkout) and the no-detector
 * disciplines for agent criteria and unmeasured deterministic ones.
 */

let repo: string;
const FIXED_NOW = new Date("2026-06-06T12:00:00.000Z");

beforeEach(async () => {
	repo = await mkdtemp(join(tmpdir(), "trellis-audit-"));
});

afterEach(async () => {
	await rm(repo, { recursive: true, force: true });
});

/** Write `content` to `relPath` under the fixture repo, creating parent dirs. */
async function put(relPath: string, content = ""): Promise<void> {
	const abs = join(repo, relPath);
	await mkdir(join(abs, ".."), { recursive: true });
	await writeFile(abs, content);
}

/** A minimal single-app TypeScript fixture: enough markers to exercise real detectors. */
async function tsFixture(): Promise<void> {
	await put("README.md", "# fixture\n");
	await put("package.json", JSON.stringify({ name: "fixture", bin: { fixture: "./cli.ts" } }));
	await put("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true } }));
	await put("biome.json", JSON.stringify({ linter: { enabled: true } }));
	await put(".gitignore", "node_modules\n");
}

describe("auditRepo end-to-end", () => {
	test("produces a coherent §6.3 report covering every rubric criterion", async () => {
		await tsFixture();
		const rubric = loadRubric();
		const report = await auditRepo(repo, { now: FIXED_NOW, rubric });

		expect(Object.keys(report.criteria)).toHaveLength(rubric.criteria.length);
		expect(report.rubricVersion).toBe(RUBRIC_VERSION);
		expect(report.level).toBeGreaterThanOrEqual(1);
		expect(report.level).toBeLessThanOrEqual(5);
		expect(report.passRate).toBeGreaterThanOrEqual(0);
		expect(report.passRate).toBeLessThanOrEqual(1);
		expect(report.coverage).toBeGreaterThanOrEqual(0);
		expect(report.coverage).toBeLessThanOrEqual(1);
		expect(report.scoredAt).toBe("2026-06-06T12:00:00.000Z");
	});

	test("discovers the repo root as a single app", async () => {
		await tsFixture();
		const report = await auditRepo(repo, { now: FIXED_NOW });
		expect(Object.keys(report.apps)).toEqual(["."]);
		expect(report.apps["."]?.description).toBe("fixture");
	});

	test("resolves agent-discovery criteria to no-detector (investigation not wired)", async () => {
		await tsFixture();
		const rubric = loadRubric();
		const report = await auditRepo(repo, { now: FIXED_NOW, rubric });
		const agentId = rubric.criteria.find((c) => c.discoveryVia === "agent")?.id;
		expect(agentId).toBeDefined();
		const entry = report.criteria[agentId as string];
		expect(entry?.numerator).toBeNull();
		expect(entry?.naKind).toBe("no-detector");
		expect(entry?.rationale).toBe(AGENT_NOT_WIRED);
	});

	test("reports an unknown commit for a non-git fixture", async () => {
		await tsFixture();
		const report = await auditRepo(repo, { now: FIXED_NOW });
		expect(report.commit).toBe("unknown");
	});

	test("every criterion entry satisfies the §6.2 numerator/naKind biconditional", async () => {
		await tsFixture();
		const report = await auditRepo(repo, { now: FIXED_NOW });
		for (const entry of Object.values(report.criteria)) {
			expect(entry.denominator).toBeGreaterThanOrEqual(1);
			if (entry.numerator === null) expect(entry.naKind).toBeDefined();
			else expect(entry.naKind).toBeUndefined();
		}
	});

	test("two runs of the same checkout serialize byte-identically (determinism)", async () => {
		await tsFixture();
		const rubric = loadRubric();
		const a = renderJson(await auditRepo(repo, { now: FIXED_NOW, rubric }));
		const b = renderJson(await auditRepo(repo, { now: FIXED_NOW, rubric }));
		expect(a).toBe(b);
	});

	test("honors a targets.yaml language hint over auto-detection", async () => {
		await put("README.md", "# poly\n");
		await put("package.json", JSON.stringify({ name: "poly", main: "./i.ts" }));
		const report = await auditRepo(repo, { now: FIXED_NOW, languages: ["python"] });
		// A python-only app leaves the TS-bound criteria with no adapter → no-detector.
		expect(report.criteria.lint_config?.naKind).toBe("no-detector");
	});
});
