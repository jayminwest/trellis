/**
 * The knip analysis fold tests (plan `pl-43c5` step 24 — trellis-8ebc): the
 * contract result over a real staged workspace — complete evidence with
 * full observed coverage over the declared scope, a staging gap that makes
 * the configured scope incomplete (never a clean pass over a partial copy),
 * and located unavailable evidence for a resolution failure, a cancelled
 * audit and an empty production selection. Real-binary tests run only
 * where the pinned artifact resolved on this host; the failure folds run
 * everywhere.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { analysisResultSchema, type KnipProviderRequest } from "../../contract/index.ts";
import { resolvePinnedTool } from "../resolve.ts";
import { runKnipAnalysis } from "./analysis.ts";
import { fixtureSelection, REACHABILITY_FIXTURE } from "./conformance.ts";

/** Real-binary tests run only where the pinned artifact resolved on this host. */
const TOOL_AVAILABLE = resolvePinnedTool("knip").state === "available";

/** A fresh conformance workspace seeded with the reachability fixture. */
async function withWorkspace(run: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "trellis-knip-analysis-"));
	try {
		for (const [path, source] of Object.entries(REACHABILITY_FIXTURE)) {
			await mkdir(dirname(join(root, path)), { recursive: true });
			await writeFile(join(root, path), source);
		}
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

/** The measured selection of the fixture workspace. */
const FIXTURE_SELECTION = fixtureSelection(Object.keys(REACHABILITY_FIXTURE));

/** The conformance request (two entries, a barrel surface, tests excluded). */
const REQUEST: KnipProviderRequest = {
	entries: ["src/main.ts", "scripts/tool.ts"],
	public: [{ path: "src/index.ts" }],
	tests: "excluded",
};

describe("runKnipAnalysis", () => {
	test.skipIf(!TOOL_AVAILABLE)(
		"folds a complete pass into contract evidence with full observed coverage over the scope",
		async () => {
			await withWorkspace(async (root) => {
				const result = await runKnipAnalysis(root, FIXTURE_SELECTION, REQUEST);
				expect(analysisResultSchema.parse(result)).toEqual(result);
				expect(result.state).toBe("complete");
				// The staged scope is the context's own: the test file that
				// supplies no evidence is outside the analysis selection.
				expect(result.analysis?.selection.files.map((file) => file.path)).toEqual(
					Object.keys(REACHABILITY_FIXTURE)
						.filter((path) => !path.endsWith(".test.ts"))
						.sort(),
				);
				expect(result.observedCoverage?.analyzedFiles).toEqual(
					Object.keys(REACHABILITY_FIXTURE)
						.filter((path) => !path.endsWith(".test.ts"))
						.sort(),
				);
				expect(result.observedCoverage?.diagnostics).toEqual([]);
				expect(result.metrics?.map((metric) => metric.id)).toContain(
					"provider.knip.candidates.total",
				);
				expect(
					result.findings?.some((finding) => finding.kind === "provider.knip.unused-file"),
				).toBe(true);
			});
		},
		20_000,
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"a staging gap makes the configured scope incomplete — never a clean pass over a partial copy",
		async () => {
			// A declared entry that resolves through a symlink escaping the
			// audited root: the measured selection carries it, the preparation
			// resolves it, and staging refuses it — so the pinned tool runs over
			// an incomplete copy and the analysis is located incomplete.
			const root = await mkdtemp(join(tmpdir(), "trellis-knip-gap-"));
			const outside = await mkdtemp(join(tmpdir(), "trellis-knip-outside-"));
			try {
				await mkdir(join(root, "src"), { recursive: true });
				await writeFile(join(root, "src/main.ts"), 'import { helper } from "./helper.ts";\n');
				await writeFile(
					join(root, "src/helper.ts"),
					"export const helper = 1;\nexport const unused = 2;\n",
				);
				await symlink(join(outside, "gone.ts"), join(root, "src/gone.ts"));
				await writeFile(join(outside, "gone.ts"), "export const gone = 0;\n");
				const selection = fixtureSelection(["src/main.ts", "src/helper.ts", "src/gone.ts"]);
				const result = await runKnipAnalysis(root, selection, {
					entries: ["src/main.ts", "src/gone.ts"],
				});
				expect(result.state).toBe("incomplete");
				expect(result.reason).toContain("configuration hints");
				expect(result.reason).toContain("1 submitted scope file(s) could not be staged");
				expect(result.observedCoverage?.diagnostics).toEqual([
					expect.objectContaining({
						path: "src/gone.ts",
						message: expect.stringContaining("outside the audited root"),
					}),
					expect.objectContaining({ message: expect.stringContaining("configuration hints") }),
				]);
				expect(analysisResultSchema.parse(result)).toEqual(result);
			} finally {
				await rm(root, { recursive: true, force: true });
				await rm(outside, { recursive: true, force: true });
			}
		},
		20_000,
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"an unresolvable pin is located unavailable evidence with actionable instructions",
		async () => {
			await withWorkspace(async (root) => {
				const result = await runKnipAnalysis(root, FIXTURE_SELECTION, REQUEST, {
					resolve: { fromDir: join(tmpdir(), "trellis-knip-not-installed-") },
				});
				expect(result.state).toBe("unavailable");
				expect(result.reason).toContain("is not installed where trellis resolves from");
				expect(result.reason).toContain("never at audit time");
				expect(analysisResultSchema.parse(result)).toEqual(result);
			});
		},
	);

	test("an empty measured selection is unsupported — no production file, no candidates", async () => {
		const result = await runKnipAnalysis(
			await mkdtemp(join(tmpdir(), "trellis-knip-empty-")),
			[],
			REQUEST,
		);
		expect(result.state).toBe("unsupported");
		expect(result.reason).toContain("no production files");
		expect(analysisResultSchema.parse(result)).toEqual(result);
	});

	test("a test-only selection is unsupported — tests never dilute production scope", async () => {
		const result = await runKnipAnalysis(
			await mkdtemp(join(tmpdir(), "trellis-knip-tests-only-")),
			fixtureSelection(["src/main.test.ts"]),
			REQUEST,
		);
		expect(result.state).toBe("unsupported");
		expect(result.reason).toContain("no production files");
	});

	test("a cancelled audit is located unavailable evidence, never an abort", async () => {
		await withWorkspace(async (root) => {
			const controller = new AbortController();
			controller.abort();
			const result = await runKnipAnalysis(root, FIXTURE_SELECTION, REQUEST, {
				signal: controller.signal,
			});
			expect(result.state).toBe("unavailable");
			expect(result.reason).toContain("cancelled");
			expect(analysisResultSchema.parse(result)).toEqual(result);
		});
	});

	test("carries the compiled policy's identity on every located result", async () => {
		await withWorkspace(async (root) => {
			const result = await runKnipAnalysis(
				root,
				FIXTURE_SELECTION,
				{},
				{
					resolve: { fromDir: join(tmpdir(), "trellis-knip-not-installed-") },
				},
			);
			expect(result.state).toBe("unavailable");
			expect(result.provider.options["reachability-policy-digest"]).toMatch(
				/^sha256:[0-9a-f]{64}$/,
			);
			expect(result.provider.options["reachability-entry-count"]).toBe(0);
			expect(result.provider.options["plugin-registry"]).toBe("disabled");
		});
	});
});
