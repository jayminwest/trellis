/**
 * The dependency-cruiser analysis fold tests (plan `pl-43c5` step 22 —
 * trellis-adbf): the contract result over a real staged workspace —
 * complete evidence with full observed coverage, located incomplete
 * evidence for a staging gap (never a clean pass over a partial view),
 * and located unavailable evidence for a resolution failure, a cancelled
 * audit and an empty selection. Real-binary tests run only where the
 * pinned artifact resolved on this host; the failure folds run everywhere.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { analysisResultSchema } from "../../contract/index.ts";
import { resolvePinnedTool } from "../resolve.ts";
import { runDependencyCruiserAnalysis } from "./analysis.ts";
import { ARCHITECTURE_FIXTURE, ARCHITECTURE_REQUEST, productionSelection } from "./conformance.ts";
import { compileArchitecturePolicy } from "./policy.ts";

/** Real-binary tests run only where the pinned artifact resolved on this host. */
const TOOL_AVAILABLE = resolvePinnedTool("dependency-cruiser").state === "available";

/** A fresh conformance workspace seeded with the architecture fixture. */
async function withWorkspace(run: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "trellis-dc-analysis-"));
	try {
		for (const [path, source] of Object.entries(ARCHITECTURE_FIXTURE)) {
			await mkdir(dirname(join(root, path)), { recursive: true });
			await writeFile(join(root, path), source);
		}
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

/** The measured selection of the fixture workspace. */
const FIXTURE_SELECTION = productionSelection(Object.keys(ARCHITECTURE_FIXTURE));

describe("runDependencyCruiserAnalysis", () => {
	test.skipIf(!TOOL_AVAILABLE)(
		"folds a complete cruise into contract evidence with full observed coverage",
		async () => {
			await withWorkspace(async (root) => {
				const result = await runDependencyCruiserAnalysis(
					root,
					FIXTURE_SELECTION,
					ARCHITECTURE_REQUEST,
				);
				expect(analysisResultSchema.parse(result)).toEqual(result);
				expect(result.state).toBe("complete");
				expect(result.observedCoverage?.analyzedFiles).toEqual(
					[...FIXTURE_SELECTION.map((file) => file.path)].sort(),
				);
				expect(result.observedCoverage?.diagnostics).toEqual([]);
				expect(result.metrics?.map((metric) => metric.id)).toEqual([
					"provider.dependency-cruiser.allowed-dependencies",
					"provider.dependency-cruiser.graph.edges",
					"provider.dependency-cruiser.graph.nodes",
					"provider.dependency-cruiser.graph.stubs",
					"provider.dependency-cruiser.violations",
				]);
				expect(result.findings?.map((finding) => finding.kind).sort()).toEqual([
					"provider.dependency-cruiser.allowed-dependency",
					"provider.dependency-cruiser.no-runtime-cycles",
					"provider.dependency-cruiser.no-type-only-cycles",
					"provider.dependency-cruiser.no-unresolved-imports",
				]);
			});
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"folds a staging gap into located incomplete evidence, never a clean pass",
		async () => {
			await withWorkspace(async (root) => {
				const selection = [
					...FIXTURE_SELECTION,
					{ path: "src/not-there.ts", sourceSet: "production" as const, packagePath: "." },
				];
				const result = await runDependencyCruiserAnalysis(root, selection, ARCHITECTURE_REQUEST);
				expect(result.state).toBe("incomplete");
				expect(result.reason).toContain("does not cover the full intended selection");
				const gap = result.observedCoverage?.diagnostics.find(
					(diagnostic) => diagnostic.path === "src/not-there.ts",
				);
				expect(gap?.message).toContain("could not be resolved");
				// The evidence that did run is still attached, namespaced and unscored.
				expect(result.metrics?.some((metric) => metric.id.endsWith("violations"))).toBe(true);
				expect(analysisResultSchema.parse(result)).toEqual(result);
			});
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"an unresolvable pin is located unavailable evidence with actionable instructions",
		async () => {
			await withWorkspace(async (root) => {
				const result = await runDependencyCruiserAnalysis(
					root,
					FIXTURE_SELECTION,
					ARCHITECTURE_REQUEST,
					{
						resolve: { fromDir: join(tmpdir(), "trellis-dc-not-installed-") },
					},
				);
				expect(result.state).toBe("unavailable");
				expect(result.reason).toContain("is not installed where trellis resolves from");
				expect(result.reason).toContain("never at audit time");
				expect(analysisResultSchema.parse(result)).toEqual(result);
			});
		},
	);

	test("an empty measured selection is unsupported — no staged file, no architecture evidence", async () => {
		const result = await runDependencyCruiserAnalysis(
			await mkdtemp(join(tmpdir(), "trellis-dc-empty-")),
			[],
			ARCHITECTURE_REQUEST,
		);
		expect(result.state).toBe("unsupported");
		expect(result.reason).toContain("the measured selection is empty");
		expect(analysisResultSchema.parse(result)).toEqual(result);
	});

	test("a cancelled audit is located unavailable evidence, never an abort", async () => {
		await withWorkspace(async (root) => {
			const controller = new AbortController();
			controller.abort();
			const result = await runDependencyCruiserAnalysis(
				root,
				FIXTURE_SELECTION,
				ARCHITECTURE_REQUEST,
				{ signal: controller.signal },
			);
			expect(result.state).toBe("unavailable");
			expect(result.reason).toContain("cancelled");
			expect(analysisResultSchema.parse(result)).toEqual(result);
		});
	});

	test("carries the compiled policy's identity on every located result", async () => {
		await withWorkspace(async (root) => {
			const result = await runDependencyCruiserAnalysis(
				root,
				FIXTURE_SELECTION,
				{ rules: [] },
				{ resolve: { fromDir: join(tmpdir(), "trellis-dc-not-installed-") } },
			);
			expect(result.state).toBe("unavailable");
			const policy = compileArchitecturePolicy({ rules: [] });
			expect(result.provider.options["architecture-rule-count"]).toBe(policy.ruleCount);
			expect(result.provider.options["architecture-policy-digest"]).toBe(`sha256:${policy.digest}`);
		});
	});
});
