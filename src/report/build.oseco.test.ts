import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OSECO_OVERLAY } from "../detectors/oseco/index.ts";
import { loadRubric } from "../rubric/index.ts";
import { auditRepo, SKIPPED_VIA_TARGETS } from "./build.ts";
import { renderJson } from "./json.ts";

/**
 * The os-eco-native detector pack (SPEC §8.4) folded through {@link auditRepo}:
 * os-eco surfaces (seeds/mulch/canopy/plot/skills/check:all/ratchets) merge over
 * the base verdict (pass if either passes), gated by the `osecoDetectors` toggle.
 * The acceptance: the pack on measurably raises honest pass rates over off.
 */
let repo: string;
const FIXED_NOW = new Date("2026-06-06T12:00:00.000Z");

beforeEach(async () => {
	repo = await mkdtemp(join(tmpdir(), "trellis-oseco-audit-"));
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

/** A minimal single-app TypeScript fixture with no os-eco surfaces. */
async function tsFixture(): Promise<void> {
	await put("README.md", "# fixture\n");
	await put("package.json", JSON.stringify({ name: "fixture", bin: { fixture: "./cli.ts" } }));
	await put("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true } }));
	await put("biome.json", JSON.stringify({ linter: { enabled: true } }));
	await put(".gitignore", "node_modules\n");
}

/** A warren-stack fixture: a plain TS app dressed with os-eco surfaces. */
async function osecoFixture(): Promise<void> {
	await tsFixture();
	await put("AGENTS.md", "# agent guide\n");
	await put("CLAUDE.md", "# claude\n");
	await put(".factory/skills/release/SKILL.md", "release skill");
	await put(".seeds/config.toml", "labels = []\n");
	await put(".seeds/issues/a.json", "{}");
	await put(".mulch/records/x.json", "{}");
	await put(".plot/work.json", "{}");
	await put(".canopy/prompts/p.md", "prompt");
	await put("docs/openapi.yaml", "openapi: 3.0.0\n");
	await put("scripts/debt-markers-budget.json", "{}");
	await put("knip.json", "{}");
	await put(".jscpd.json", "{}");
	await put(
		"package.json",
		JSON.stringify({
			name: "fixture",
			bin: { fixture: "./cli.ts" },
			scripts: {
				test: "bun test",
				"check:all": "bun run lint",
				"check:file-size": "x",
				"check:quality": "x",
				"check:bundle": "x",
				"gen:openapi": "x",
			},
		}),
	);
	await put(
		".github/workflows/ci.yml",
		"jobs:\n  c:\n    steps:\n      - run: bun run check:all\n",
	);
	await put(".githooks/pre-commit", "#!/bin/sh\nbun run check:all\n");
}

describe("auditRepo os-eco-native detectors (SPEC §8.4)", () => {
	/** Agent criteria with no investigation wired: no-detector off → os-eco pass on. */
	const AGENT_LIFTED = [
		"agents_md",
		"skills",
		"automated_doc_generation",
		"documentation_freshness",
		"agentic_development",
	];

	/** Every criterion SPEC §8.4 maps an os-eco surface onto. */
	const MAPPED = Object.keys(OSECO_OVERLAY);

	/** Passing fraction of an entry (null numerator → 0); used for monotonicity checks. */
	const frac = (e: { numerator: number | null; denominator: number } | undefined): number =>
		e === undefined || e.numerator === null ? 0 : e.numerator / e.denominator;

	test("the pack on raises honest pass rates vs off (acceptance)", async () => {
		await osecoFixture();
		const rubric = loadRubric();
		const off = await auditRepo(repo, { now: FIXED_NOW, rubric, osecoDetectors: false });
		const on = await auditRepo(repo, { now: FIXED_NOW, rubric, osecoDetectors: true });
		expect(on.passRate).toBeGreaterThan(off.passRate);
	});

	test("merges, never replaces — no mapped criterion regresses, agent ones flip to pass", async () => {
		await osecoFixture();
		const rubric = loadRubric();
		const off = await auditRepo(repo, { now: FIXED_NOW, rubric, osecoDetectors: false });
		const on = await auditRepo(repo, { now: FIXED_NOW, rubric, osecoDetectors: true });
		// pass-if-either is monotonic: the overlay never lowers a verdict.
		for (const id of MAPPED)
			expect(frac(on.criteria[id])).toBeGreaterThanOrEqual(frac(off.criteria[id]));
		// the agent criteria are no-detector off → full pass on, with the evidence path named.
		for (const id of AGENT_LIFTED) {
			expect(off.criteria[id]?.naKind).toBe("no-detector");
			expect(on.criteria[id]?.numerator).toBe(on.criteria[id]?.denominator ?? -1);
			expect(on.criteria[id]?.rationale).toMatch(/os-eco|\.seeds|\.mulch|\.plot|\.canopy|skill/i);
		}
	});

	test("defaults to on (undefined toggle behaves like true)", async () => {
		await osecoFixture();
		const report = await auditRepo(repo, { now: FIXED_NOW });
		expect(report.criteria.agents_md?.numerator).toBe(1);
		expect(report.criteria.documentation_freshness?.numerator).toBe(1);
	});

	test("a missing os-eco surface is a no-op — never lowers a base verdict", async () => {
		// A plain TS fixture with no os-eco surfaces: pack on must not change any verdict.
		await tsFixture();
		const rubric = loadRubric();
		const off = renderJson(
			await auditRepo(repo, { now: FIXED_NOW, rubric, osecoDetectors: false }),
		);
		const on = renderJson(await auditRepo(repo, { now: FIXED_NOW, rubric, osecoDetectors: true }));
		expect(on).toBe(off);
	});

	test("targets.yaml skip wins over the overlay", async () => {
		await osecoFixture();
		const report = await auditRepo(repo, {
			now: FIXED_NOW,
			osecoDetectors: true,
			skip: ["agents_md"],
		});
		expect(report.criteria.agents_md?.naKind).toBe("not-applicable");
		expect(report.criteria.agents_md?.rationale).toBe(SKIPPED_VIA_TARGETS);
	});

	test("overlay preserves byte-determinism across same-checkout runs", async () => {
		await osecoFixture();
		const rubric = loadRubric();
		const a = renderJson(await auditRepo(repo, { now: FIXED_NOW, rubric }));
		const b = renderJson(await auditRepo(repo, { now: FIXED_NOW, rubric }));
		expect(a).toBe(b);
	});
});
