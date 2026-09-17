import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { auditReportSchema, measurementPayload, SCHEMA_VERSION } from "../contract/index.ts";
import { discoverSourceInventory } from "../discovery/index.ts";
import {
	analyzeComplexity,
	analyzeCycles,
	analyzeDependencyGraph,
	analyzeDuplication,
} from "../metrics/index.ts";
import { inspectSafeguards } from "../safeguards/index.ts";
import { scoreSloppiness } from "../scoring/index.ts";
import { buildSyntaxInventory } from "../syntax/index.ts";
import { assembleReport, collectMetrics } from "./assemble.ts";
import { auditWorkspace, measureAnalyses, selectedMeasuredAnalyzers } from "./audit.ts";
import { ANALYZER_IDS, type AuditEvent, analyzerProgressId } from "./progress.ts";
import { runWorkspaceAudit } from "./run.ts";

/**
 * Audit orchestration through the native capability registry (trellis-1e66,
 * plan pl-43c5 step 4). The refactor routes the measure phase through the
 * registered analyzer runs (`src/analysis/`) instead of calling the four
 * analyzers inline; these tests prove native behavior is preserved: the
 * measurement payload is byte-equal to the pre-refactor pipeline rebuilt by
 * hand, the shared parse and the produced graph are consumed exactly once,
 * progress derives from the selected execution list, incomplete results keep
 * their downstream handling with no provider selected, and the core, the run
 * service and the CLI stay one path over dirty, non-Git workspaces.
 */

const CLI = resolve(import.meta.dir, "../cli/main.ts");
/** Pinned run clock so assembled reports differ only in `run.durationMs`. */
const PINNED = new Date("2026-01-01T00:00:00.000Z");

let repo: string;

beforeEach(async () => {
	repo = await mkdtemp(join(tmpdir(), "trellis-orchestration-"));
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

/**
 * 105 normalized tokens over 13 lines — above the clone minimums (SPEC §5.3)
 * — with cyclomatic complexity 10, below the erosion threshold, so clone
 * fixtures never leak hotspot findings.
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

/** An eroded function (CC 12 > threshold 10): a `complexity.hotspot` finding. */
function tangledFunction(name: string): string {
	const branches = Array.from(
		{ length: 11 },
		(_, i) => `\tif (n > ${i}) {\n\t\tout += ${i};\n\t}`,
	).join("\n");
	return `export function ${name}(n: number): number {\n\tlet out = 0;\n${branches}\n\treturn out;\n}\n`;
}

/**
 * Seed a workspace exercising every measured analyzer: a clone group, an
 * import cycle, an unresolved import, and an erosion hotspot. Not a Git
 * repository — the audit never reads one.
 */
async function seedSloppy(): Promise<void> {
	await put("package.json", JSON.stringify({ name: "fixture-orchestration", version: "1.0.0" }));
	await put("src/clone-a.ts", CLONE_FN);
	await put("src/clone-b.ts", CLONE_FN);
	await put("src/a.ts", 'import { b } from "./b.ts";\nexport const a = b;\n');
	await put("src/b.ts", 'import { a } from "./a.ts";\nexport const b = a;\n');
	await put("src/lost.ts", 'import { gone } from "./missing.ts";\nexport const lost = gone;\n');
	await put("src/tangled.ts", tangledFunction("tangled"));
}

/** Spawn the CLI audit and capture exit code + stdout. */
async function runCliJson(path: string): Promise<{ code: number; stdout: string }> {
	const child = Bun.spawn([process.execPath, CLI, "audit", path, "--json", "--quiet"], {
		cwd: path,
		env: { ...process.env, TRELLIS_LOG_LEVEL: "silent" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
	return { code, stdout };
}

describe("audit orchestration through the registry", () => {
	test("matches the pre-refactor pipeline's measurement payload exactly", async () => {
		await seedSloppy();
		// The pre-refactor pipeline, rebuilt by hand: the raw inline analyzers
		// over one discover+parse, folded by the same pure assembly with the
		// raw products as its measured sources and the run clock pinned.
		const source = await discoverSourceInventory(repo);
		const syntax = await buildSyntaxInventory(source);
		const complexity = analyzeComplexity(syntax);
		const duplication = analyzeDuplication(syntax);
		const graph = analyzeDependencyGraph(source, syntax);
		const cycles = analyzeCycles(graph);
		const safeguards = await inspectSafeguards(source.root);
		const metrics = collectMetrics([complexity, duplication, graph, cycles]);
		const baseline = assembleReport(
			{ source, syntax, analyses: [complexity, duplication, graph, cycles], safeguards },
			scoreSloppiness(metrics),
			{ auditedAt: PINNED.toISOString() },
		);
		const refactored = await auditWorkspace(repo, { now: PINNED });
		// Byte equality: metrics, findings (and their order), coverage, score.
		expect(JSON.stringify(measurementPayload(refactored))).toBe(
			JSON.stringify(measurementPayload(baseline)),
		);
		expect(refactored.run?.auditedAt).toBe(PINNED.toISOString());
		// The fixture exercises all four measured analyzers' evidence (the
		// tangled function's eleven normalized-identical branches form a second
		// clone group alongside the cloned file pair).
		expect(refactored.findings.map((finding) => finding.kind).sort()).toEqual([
			"complexity.hotspot",
			"duplication.clone-group",
			"duplication.clone-group",
			"graph.unresolved-import",
			"import-cycle",
		]);
	});

	test("measures from one shared parse and feeds the cycle analyzer the produced graph", async () => {
		await seedSloppy();
		const source = await discoverSourceInventory(repo);
		const syntax = await buildSyntaxInventory(source);
		const runs = measureAnalyses(source, syntax);
		// Selection and order come from the registry, not a hardcoded list.
		expect(selectedMeasuredAnalyzers().map((analyzer) => analyzer.identity.id)).toEqual([
			"trellis.complexity",
			"trellis.dependency-graph",
			"trellis.duplication",
			"trellis.import-cycles",
		]);
		expect(runs.map((run) => run.result.provider.id)).toEqual([
			"trellis.complexity",
			"trellis.dependency-graph",
			"trellis.duplication",
			"trellis.import-cycles",
		]);
		// Every selected run analyzed the same shared parse (the passes are the
		// inputs; measurement cannot re-discover or re-parse).
		for (const run of runs) {
			expect(run.result.analysis?.parser).toEqual({
				engine: "trellis.typescript",
				version: syntax.compilerVersion,
			});
		}
		// The cycle analyzer consumed the exact graph run the registry ordered
		// before it — the wrapper reference-copies the graph's identity, so a
		// re-derived graph would be deep-equal but never the same object.
		const graph = runs.find((run) => run.result.provider.id === "trellis.dependency-graph");
		const cycles = runs.find((run) => run.result.provider.id === "trellis.import-cycles");
		expect(cycles?.result.analysis).toBe(graph?.result.analysis);
		expect(cycles?.result.observedCoverage).toBe(graph?.result.observedCoverage);
		expect(cycles?.result.state).toBe(graph?.result.state);
	});

	test("derives analyzer progress from the selected execution list, deterministically", async () => {
		await seedSloppy();
		const events: AuditEvent[] = [];
		await auditWorkspace(repo, { now: PINNED, onProgress: (event) => events.push(event) });
		const analyzers = events.filter(
			(event): event is Extract<AuditEvent, { type: "analyzer" }> => event.type === "analyzer",
		);
		expect(analyzers.map((event) => event.id)).toEqual([...ANALYZER_IDS]);
		expect(analyzers.map((event) => event.id)).toEqual(
			selectedMeasuredAnalyzers().map((analyzer) => analyzerProgressId(analyzer.identity.id)),
		);
		expect(analyzers.map((event) => event.index)).toEqual([0, 1, 2, 3]);
		expect(analyzers.every((event) => event.total === selectedMeasuredAnalyzers().length)).toBe(
			true,
		);
		// Deterministic: a second run emits the identical bounded sequence.
		const second: AuditEvent[] = [];
		await auditWorkspace(repo, { onProgress: (event) => second.push(event) });
		expect(second).toEqual(events);
		// Listening to progress never alters the evidence (payload equality).
		const silent = await auditWorkspace(repo, { now: PINNED });
		expect(measurementPayload(silent)).toEqual(
			measurementPayload(await auditWorkspace(repo, { now: PINNED, onProgress: () => {} })),
		);
	});

	test("keeps incomplete native results on their current path and selects no provider", async () => {
		await seedSloppy();
		await put("src/broken.ts", "export const nope = ;\n");
		const report = await auditWorkspace(repo);
		expect(auditReportSchema.parse(report)).toEqual(report);
		// Incomplete native results keep the §3.3 rollup behavior (the same
		// downstream handling as the pre-refactor path).
		expect(report.completeness).toBe("incomplete");
		expect(report.score.partial).toBe(true);
		const source = await discoverSourceInventory(repo);
		const syntax = await buildSyntaxInventory(source);
		for (const run of measureAnalyses(source, syntax)) {
			// Only native analyzers were selected and started — no provider.
			expect(run.result.provider.kind).toBe("native");
			expect(run.result.state).toBe("incomplete");
			expect(run.result.reason).toMatch(/parse diagnostics/);
		}
		// The report shape is untouched: no provider field, no new version.
		expect(Object.keys(report).sort()).toEqual([
			"analyzerVersion",
			"completeness",
			"findings",
			"metrics",
			"repo",
			"run",
			"safeguards",
			"schemaVersion",
			"score",
			"scoringVersion",
			"sourceCoverage",
		]);
		expect(report.schemaVersion).toBe(SCHEMA_VERSION);
	});

	test("stays one code path across core, service and CLI over a dirty, non-Git workspace", async () => {
		await seedSloppy();
		// Dirty: an uncommitted change lands between audits; non-Git: the
		// workspace is a bare temp directory with no repository anywhere.
		const before = await auditWorkspace(repo, { now: PINNED });
		await put("src/tangled-2.ts", tangledFunction("tangled2"));
		const core = await auditWorkspace(repo, { now: PINNED });
		expect(core.score.index).toBeGreaterThan(before.score.index);
		expect(core.findings.some((finding) => finding.path === "src/tangled-2.ts")).toBe(true);
		// The run service both surfaces fold reports the same measurement.
		const service = await runWorkspaceAudit(repo, { now: PINNED });
		expect(measurementPayload(service.report)).toEqual(measurementPayload(core));
		// And so does a real CLI invocation of the same dirty workspace.
		const cli = await runCliJson(repo);
		expect(cli.code).toBe(0);
		expect(measurementPayload(auditReportSchema.parse(JSON.parse(cli.stdout)))).toEqual(
			measurementPayload(core),
		);
	});
});

describe("analyzerProgressId", () => {
	test("maps registry analyzer ids onto the progress surface and rejects unknown ids", () => {
		expect(analyzerProgressId("trellis.complexity")).toBe("complexity");
		expect(analyzerProgressId("trellis.dependency-graph")).toBe("dependency-graph");
		expect(analyzerProgressId("trellis.duplication")).toBe("duplication");
		expect(analyzerProgressId("trellis.import-cycles")).toBe("import-cycles");
		expect(() => analyzerProgressId("trellis.brand-new")).toThrow(/no progress id/);
	});
});
