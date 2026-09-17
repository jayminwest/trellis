import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ANALYZER_VERSION,
	type AuditReport,
	auditConfigSchema,
	auditReportSchema,
	findingSchema,
	measurementPayload,
	SCHEMA_VERSION,
	SCORING_VERSION,
} from "../contract/index.ts";
import { SAFEGUARD_IDS } from "../safeguards/index.ts";
import { auditWorkspace } from "./audit.ts";
import { ANALYZER_IDS, type AuditEvent } from "./progress.ts";

let repo: string;

beforeEach(async () => {
	repo = await mkdtemp(join(tmpdir(), "trellis-audit-core-"));
});

afterEach(async () => {
	await rm(repo, { recursive: true, force: true });
});

/** Write `content` to `relPath` under the temp repo, creating parent dirs. */
async function put(relPath: string, content: string): Promise<void> {
	const abs = join(repo, relPath);
	await mkdir(join(abs, ".."), { recursive: true });
	await writeFile(abs, content);
}

/** Seed a minimal clean workspace: two production modules and one test file. */
async function seedClean(): Promise<void> {
	await put("package.json", JSON.stringify({ name: "fixture-clean", version: "1.0.0" }));
	await put(
		"src/alpha.ts",
		"export function alpha(input: number): number {\n\tif (input > 0) {\n\t\treturn input * 2;\n\t}\n\treturn 0;\n}\n",
	);
	await put("src/beta.ts", 'import { alpha } from "./alpha.ts";\nexport const beta = alpha(1);\n');
	await put(
		"src/alpha.test.ts",
		'import { alpha } from "./alpha.ts";\nexport const t = alpha(2);\n',
	);
}

/** An eroded function (CC 12 > threshold 10): a `complexity.hotspot` finding. */
function tangledFunction(name: string): string {
	const branches = Array.from(
		{ length: 11 },
		(_, i) => `\tif (n > ${i}) {\n\t\tout += ${i};\n\t}`,
	).join("\n");
	return `export function ${name}(n: number): number {\n\tlet out = 0;\n${branches}\n\treturn out;\n}\n`;
}

/**
 * 105 normalized tokens over 13 lines — above the clone minimums (SPEC
 * §5.3) — with cyclomatic complexity 10, below the erosion threshold, so
 * clone fixtures never leak hotspot findings.
 */
const CLONE_FN =
	"export function alpha(a: number, b: number) {\n" +
	"\tconst s = a + b;\n" +
	"\tif (a > 0) return 1;\n" +
	"\tif (a > 1) return 2;\n" +
	"\tif (a > 2) return 3;\n" +
	"\tif (a > 3) return 4;\n" +
	"\tif (a > 4) return 5;\n" +
	"\tif (a > 5) return 6;\n" +
	"\tif (a > 6) return 7;\n" +
	"\tif (a > 7) return 8;\n" +
	"\tif (a > 8) return 9;\n" +
	"\treturn s;\n" +
	"}\n";

/** Every finding on the report satisfies the §6.2 contract. */
function expectFindingsValid(report: AuditReport): void {
	for (const finding of report.findings) findingSchema.parse(finding);
}

/** Recursive, sorted, repo-relative file listing (zero-footprint snapshot). */
async function tree(dir: string, prefix = ""): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : 1));
	const paths: string[] = [];
	for (const entry of sorted) {
		const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		paths.push(rel);
		if (entry.isDirectory()) paths.push(...(await tree(join(dir, entry.name), rel)));
	}
	return paths;
}

describe("auditWorkspace over a clean workspace", () => {
	test("assembles a complete, schema-valid §6.4 report", async () => {
		await seedClean();
		const report = await auditWorkspace(repo, { now: new Date("2026-01-01T00:00:00.000Z") });
		expect(auditReportSchema.parse(report)).toEqual(report);
		expect(report.schemaVersion).toBe(SCHEMA_VERSION);
		expect(report.analyzerVersion).toBe(ANALYZER_VERSION);
		expect(report.scoringVersion).toBe(SCORING_VERSION);
		expect(report.repo).toEqual({ root: repo, identity: "fixture-clean" });
		expect(report.completeness).toBe("complete");
		expect(report.score.direction).toBe("lower-is-better");
		expect(report.score.partial).toBe(false);
		expect(report.score.index).toBe(0);
		expect(report.run?.auditedAt).toBe("2026-01-01T00:00:00.000Z");
		expect(report.run?.durationMs).toBeGreaterThanOrEqual(0);
		// Coverage: classified scopes carry files + measured sloc (§3.1).
		expect(report.sourceCoverage.production.files).toBe(2);
		expect(report.sourceCoverage.production.sloc).toBeGreaterThan(0);
		expect(report.sourceCoverage.test.files).toBe(1);
		expect(report.sourceCoverage.unsupported).toBeUndefined();
		// Every formula-required metric is present; the metrics map is sorted.
		const ids = Object.keys(report.metrics);
		expect(ids).toEqual([...ids].sort());
		for (const id of [
			"erosion.eroded-count.production",
			"erosion.eroded-share.production",
			"duplication.density.production",
			"duplication.groups.production",
			"import-cycle.density",
			"import-cycle.groups",
		]) {
			expect(report.metrics[id]).toBeDefined();
		}
		// Safeguards are the full fixed panel, separate from the score (§5.5).
		expect(report.safeguards.map((result) => result.id)).toEqual([...SAFEGUARD_IDS]);
		expectFindingsValid(report);
	});

	test("yields byte-equal measurement payloads for identical inputs", async () => {
		await seedClean();
		const first = await auditWorkspace(repo, { now: new Date("2026-01-01T00:00:00.000Z") });
		const second = await auditWorkspace(repo, { now: new Date("2026-06-01T00:00:00.000Z") });
		expect(JSON.stringify(measurementPayload(first))).toBe(
			JSON.stringify(measurementPayload(second)),
		);
		// Run metadata may differ — it is excluded from the payload (§3.5).
		expect(first.run?.auditedAt).not.toBe(second.run?.auditedAt);
	});

	test("writes nothing to the audited workspace", async () => {
		await seedClean();
		const before = await tree(repo);
		await auditWorkspace(repo);
		expect(await tree(repo)).toEqual(before);
	});
});

describe("auditWorkspace determinism over a changing worktree", () => {
	test("analyzes dirty worktrees as they exist, with no Git requirement", async () => {
		await seedClean();
		const before = await auditWorkspace(repo);
		expect(before.findings.filter((f) => f.kind === "complexity.hotspot")).toEqual([]);
		// An uncommitted, non-Git change is visible to the next run immediately.
		await put("src/tangled.ts", tangledFunction("tangled"));
		const after = await auditWorkspace(repo);
		const hotspots = after.findings.filter((f) => f.kind === "complexity.hotspot");
		expect(hotspots.map((f) => f.path)).toEqual(["src/tangled.ts"]);
		expect(after.metrics["erosion.eroded-count.production"]).toMatchObject({
			state: "complete",
			value: 1,
		});
		expect(after.score.index).toBeGreaterThan(before.score.index);
	});
});

describe("auditWorkspace over unsupported and excluded source", () => {
	test("reports non-TS languages as unsupported coverage, never cleanliness", async () => {
		await seedClean();
		const baseline = await auditWorkspace(repo);
		await put("lib/tool.py", "def tool():\n    return 1\n");
		await put("lib/tool.go", "package main\n\nfunc tool() int {\n\treturn 1\n}\n");
		const report = await auditWorkspace(repo);
		expect(report.sourceCoverage.unsupported).toEqual({
			files: 2,
			note: "non-TS sources, not analyzed",
		});
		expect(report.completeness).toBe("complete");
		// Unsupported surface never changes the measurement (§3.3).
		expect(report.score).toEqual(baseline.score);
		expect(report.metrics).toEqual(baseline.metrics);
	});

	test("honors source.exclude from the declarative audit configuration", async () => {
		await seedClean();
		await put("src/skipped/noisy.ts", tangledFunction("noisy"));
		await put("trellis.yaml", 'source:\n  exclude: ["src/skipped/**"]\n');
		const report = await auditWorkspace(repo);
		expect(report.sourceCoverage.excluded).toMatchObject({ files: 1 });
		expect(report.findings.filter((f) => f.kind === "complexity.hotspot")).toEqual([]);
		expect(report.completeness).toBe("complete");
	});

	test("honors a preloaded configuration over the file on disk", async () => {
		await seedClean();
		await put("scripts/tools/reindex.ts", "export const reindex = 1;\n");
		const config = auditConfigSchema.parse({
			source: { classify: { "scripts/**": "test" } },
		});
		const report = await auditWorkspace(repo, { config });
		expect(report.sourceCoverage.test.files).toBe(2);
		expect(report.sourceCoverage.production.files).toBe(2);
	});

	test("rejects an invalid trellis.yaml as an operational error", async () => {
		await seedClean();
		await put("trellis.yaml", "policy:\n  maxIndex: high\n");
		await expect(auditWorkspace(repo)).rejects.toThrow(/invalid trellis\.yaml/);
	});
});

describe("auditWorkspace under partial analysis", () => {
	test("degrades parse failures to incomplete metrics while remaining findings stay useful", async () => {
		await put("package.json", JSON.stringify({ name: "fixture-broken" }));
		await put("src/a.ts", 'import { b } from "./b.ts";\nexport const a = b;\n');
		await put("src/b.ts", 'import { a } from "./a.ts";\nexport const b = a;\n');
		await put("src/broken.ts", "export const nope = ;\n");
		const report = await auditWorkspace(repo);
		expect(auditReportSchema.parse(report)).toEqual(report);
		expect(report.completeness).toBe("incomplete");
		expect(report.score.partial).toBe(true);
		// The affected metrics say what could not be analyzed (§3.3).
		expect(report.metrics["complexity.functions.production"]?.state).toBe("incomplete");
		expect(report.metrics["complexity.functions.production"]?.reason).toMatch(
			/1 production file\(s\) produced parse diagnostics/,
		);
		// Unrelated analyzers still produced their findings.
		expect(report.findings.some((f) => f.kind === "import-cycle")).toBe(true);
		expectFindingsValid(report);
	});

	test("reports unresolved imports with located findings instead of failing", async () => {
		await put("src/a.ts", 'import { gone } from "./missing.ts";\nexport const a = gone;\n');
		const report = await auditWorkspace(repo);
		expect(report.completeness).toBe("incomplete");
		expect(report.metrics["graph.edges.unresolved"]).toMatchObject({
			state: "incomplete",
			value: 1,
		});
		// An incomplete graph never yields an apparently clean cycle result.
		expect(report.metrics["import-cycle.groups"]?.state).toBe("incomplete");
		const finding = report.findings.find((f) => f.kind === "graph.unresolved-import");
		expect(finding).toBeDefined();
		expect(finding?.path).toBe("src/a.ts");
		expect(finding?.range.start.line).toBe(1);
	});

	test("turns duplication budget exhaustion into incomplete metrics, not a clean result", async () => {
		await put("src/a.ts", CLONE_FN);
		await put("src/b.ts", CLONE_FN);
		const report = await auditWorkspace(repo, {
			duplicationBudget: { maxTokens: 1, maxMatchWork: 1 },
		});
		expect(report.completeness).toBe("incomplete");
		expect(report.score.partial).toBe(true);
		expect(report.metrics["duplication.density.production"]).toMatchObject({
			state: "incomplete",
		});
		expect(report.metrics["duplication.density.production"]?.reason).toMatch(
			/token budget of 1 exceeded/,
		);
	});
});

describe("auditWorkspace findings and score", () => {
	test("orders findings by kind with clone groups, hotspots, and cycles located", async () => {
		await put("src/a.ts", CLONE_FN);
		await put("src/b.ts", `${CLONE_FN}import { a } from "./a.ts";\nexport const b = a;\n`);
		await put("src/tangled.ts", tangledFunction("tangled"));
		const report = await auditWorkspace(repo);
		expect(auditReportSchema.parse(report)).toEqual(report);
		const kinds = report.findings.map((f) => f.kind);
		expect(kinds).toEqual([...kinds].sort());
		expect(kinds).toContain("duplication.clone-group");
		expect(kinds).toContain("complexity.hotspot");
		// Every contribution point traces to a metric on the report (§7).
		for (const contribution of report.score.contributions) {
			for (const metricId of contribution.metricIds) {
				expect(report.metrics[metricId]).toBeDefined();
			}
		}
		expect(
			report.score.contributions.reduce((sum, contribution) => sum + contribution.points, 0),
		).toBe(report.score.index);
		expectFindingsValid(report);
	});

	test("never lets safeguard infrastructure offset the index", async () => {
		await put("package.json", JSON.stringify({ name: "fixture-bare" }));
		await put("src/tangled.ts", tangledFunction("tangled"));
		const bare = await auditWorkspace(repo);
		// Pretty-printed: the safeguard scan's documented subset is one script per line.
		await put(
			"package.json",
			JSON.stringify(
				{
					name: "fixture-tooled",
					scripts: {
						lint: "biome check .",
						typecheck: "tsc --noEmit",
						test: "bun test",
					},
				},
				null,
				2,
			),
		);
		const tooled = await auditWorkspace(repo);
		expect(tooled.score).toEqual(bare.score);
		const evidence = new Map(tooled.safeguards.map((r) => [r.id, r.evidence]));
		expect(evidence.get("lint-script")).not.toBe("absent");
		expect(evidence.get("typecheck-script")).not.toBe("absent");
	});
});

describe("auditWorkspace over an empty workspace", () => {
	test("reports a function-free workspace honestly with not-applicable ratios", async () => {
		await put("src/types.d.ts", "export declare const value: number;\n");
		const report = await auditWorkspace(repo);
		expect(auditReportSchema.parse(report)).toEqual(report);
		expect(report.completeness).toBe("complete");
		expect(report.score.partial).toBe(false);
		expect(report.score.index).toBe(0);
		expect(report.sourceCoverage.production.files).toBe(0);
		expect(report.sourceCoverage["declaration-only"]?.files).toBe(1);
		expect(report.metrics["complexity.functions.production"]).toMatchObject({
			state: "complete",
			value: 0,
		});
		expect(report.metrics["complexity.cc.p50.production"]?.state).toBe("not-applicable");
		expect(report.metrics["duplication.density.production"]?.state).toBe("not-applicable");
		// The declaration-only file is still a graph node, so the cycle density is a real 0.
		expect(report.metrics["import-cycle.density"]).toMatchObject({ state: "complete", value: 0 });
	});
});

describe("auditWorkspace progress events", () => {
	test("emits the bounded pipeline sequence regardless of repository size", async () => {
		await seedClean();
		const small: AuditEvent[] = [];
		await auditWorkspace(repo, { onProgress: (event) => small.push(event) });
		const types = small.map((event) => event.type);
		expect(types).toEqual([
			"phase",
			"phase",
			"source-discovered",
			"phase",
			"syntax-built",
			"phase",
			"analyzer",
			"analyzer",
			"analyzer",
			"analyzer",
			"measured",
			"phase",
			"safeguards-inspected",
			"phase",
			"scored",
			"phase",
		]);
		const phases = small.filter((event) => event.type === "phase").map((event) => event.phase);
		expect(phases).toEqual([
			"configure",
			"discover",
			"parse",
			"measure",
			"safeguards",
			"score",
			"assemble",
		]);
		const analyzers = small.filter((event) => event.type === "analyzer");
		expect(analyzers.map((event) => event.id)).toEqual([...ANALYZER_IDS]);
		expect(analyzers.every((event) => event.total === ANALYZER_IDS.length)).toBe(true);
		// A much larger workspace emits the same number of events (bounded).
		for (let i = 0; i < 25; i += 1) {
			await put(`src/more/file-${i}.ts`, `export const value${i} = ${i};\n`);
		}
		const large: AuditEvent[] = [];
		await auditWorkspace(repo, { onProgress: (event) => large.push(event) });
		expect(large.length).toBe(small.length);
	});

	test("produces an identical report with and without a progress sink", async () => {
		await seedClean();
		const silent = await auditWorkspace(repo, { now: new Date("2026-01-01T00:00:00.000Z") });
		const observed = await auditWorkspace(repo, {
			now: new Date("2026-01-01T00:00:00.000Z"),
			onProgress: () => {},
		});
		expect(JSON.stringify(measurementPayload(observed))).toBe(
			JSON.stringify(measurementPayload(silent)),
		);
	});
});
