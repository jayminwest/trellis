/**
 * Input-surface conformance for the jscpd provider (plan `pl-43c5` —
 * trellis-b0ec, step 14, acceptance 2 and 3): TSX with template and regex
 * literals, malformed syntax above the token threshold, below-threshold
 * files as undisclosed coverage, mixed production/test source sets,
 * selection scope exclusion, target-owned provider configuration, and
 * within-file repeats — over no-dependency, non-Git workspaces through the
 * real pinned binary.
 *
 * Parser support is never inferred from exit 0: coverage is asserted from
 * the tool's own source statistics (the coverage account), and the
 * malformed control records the pinned tool's actual lenience — its
 * tokenizer counts broken syntax as a source, while its AST-similarity
 * matcher never pairs the unparseable file with the valid one.
 */
import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { CLONE_MATCH_MODES } from "../../contract/index.ts";
import { resolvePinnedTool } from "../resolve.ts";
import { runJscpdAdapter } from "./adapter.ts";
import {
	BROKEN_FUNCTION,
	fixtureTexts,
	lineAccount,
	locationOf,
	pairEvidence,
	productionSelection,
	requireComplete,
	requireIncomplete,
	runConformanceAdapter,
	TSX_COMPONENT,
	withConformanceWorkspace,
} from "./conformance.ts";
import { TOTAL_FUNCTION } from "./normalize.fixtures.ts";
import { normalizeJscpdReport } from "./normalize.ts";

/** Real-binary tests run only where the pinned artifact resolved on this host. */
const TOOL_AVAILABLE = resolvePinnedTool("jscpd").state === "available";

describe("runJscpdAdapter conformance (input surfaces)", () => {
	test.skipIf(!TOOL_AVAILABLE)(
		"analyzes TSX with template and regex literals as its own format",
		async () => {
			const run = await runConformanceAdapter({ "a.tsx": TSX_COMPONENT, "b.tsx": TSX_COMPONENT });
			for (const mode of CLONE_MATCH_MODES) {
				const outcome = requireComplete(run, mode);
				expect(outcome.coverage.analyzedFiles).toEqual(["a.tsx", "b.tsx"]);
				expect(Object.keys(outcome.report.statistics.formats)).toEqual(["tsx"]);
			}
			const normalized = run.normalizedOf("exact");
			expect(normalized?.cloneEvidence).toEqual([
				pairEvidence("exact", locationOf("a.tsx", 1, 7), locationOf("b.tsx", 1, 7)),
			]);
			expect(normalized?.findings[0]?.facts).toMatchObject({
				format: "tsx",
				lines: 7,
				tokens: 87,
			});
			expect(normalized?.lineAccounting.production).toEqual(lineAccount(2, 14, 14));
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"tokenizes malformed-but-thresholded syntax without claiming AST support for it",
		async () => {
			const run = await runConformanceAdapter({
				"a.ts": TOTAL_FUNCTION,
				"b.ts": BROKEN_FUNCTION,
				"c.ts": BROKEN_FUNCTION,
			});
			for (const mode of ["exact", "near"] as const) {
				// The lenient tokenizer counts the malformed files as sources, so the
				// coverage account fully reconciles — observed coverage, not an exit-0 guess.
				expect(requireComplete(run, mode).coverage.analyzedFiles).toEqual(["a.ts", "b.ts", "c.ts"]);
			}
			// The two identical malformed copies pair exactly (token identity survives the
			// broken grammar); the trellis side still classifies every file (42 code lines).
			const exact = run.normalizedOf("exact");
			expect(exact?.cloneEvidence).toEqual([
				pairEvidence("exact", locationOf("b.ts", 1, 14), locationOf("c.ts", 1, 14)),
			]);
			expect(exact?.findings[0]?.facts).toMatchObject({ tokens: 91 });
			expect(exact?.lineAccounting.production).toEqual(lineAccount(3, 42, 28));
			// AST similarity never pairs the malformed file with the valid one: the near
			// mode reports only the token-exact malformed pair — no parser support inferred.
			expect(run.normalizedOf("near")?.cloneEvidence).toEqual([
				pairEvidence("exact", locationOf("b.ts", 1, 14), locationOf("c.ts", 1, 14)),
			]);
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"treats a below-threshold file as omitted coverage, never a clean result",
		async () => {
			const run = await runConformanceAdapter({
				...fixtureTexts("exact"),
				"tiny.ts": "export const x = 1;\n",
			});
			for (const mode of CLONE_MATCH_MODES) {
				const outcome = requireIncomplete(run, mode);
				expect(outcome.reason).toContain(
					"1 of 3 staged files are omitted from jscpd's source statistics",
				);
				expect(outcome.coverage).toEqual({
					selectedFiles: 3,
					reportedSources: 2,
					omittedFromSourceStatistics: 1,
				});
				// Per-file observed coverage cannot be enumerated from the provider's evidence.
				expect(outcome.coverage?.analyzedFiles).toBeUndefined();
				// The pair over the two above-threshold files stays visible, never dropped.
				expect(outcome.report?.duplicates).toHaveLength(1);
				expect(outcome.exitCode).toBe(0);
			}
			expect(run.normalizedOf("exact")?.lineAccounting.production).toEqual(lineAccount(3, 29, 28));
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"accounts a cross-source-set pair in each set's own ledger",
		async () => {
			const run = await runConformanceAdapter(
				{ "src/a.ts": TOTAL_FUNCTION, "src/a.test.ts": TOTAL_FUNCTION },
				{},
				[
					{ path: "src/a.ts", sourceSet: "production" as const, packagePath: "." },
					{ path: "src/a.test.ts", sourceSet: "test" as const, packagePath: "." },
				],
			);
			expect(requireComplete(run, "exact").coverage.analyzedFiles).toEqual([
				"src/a.test.ts",
				"src/a.ts",
			]);
			const normalized = run.normalizedOf("exact");
			expect(normalized?.cloneEvidence).toEqual([
				pairEvidence("exact", locationOf("src/a.test.ts", 1, 14), locationOf("src/a.ts", 1, 14)),
			]);
			// One pair, two ledgers: each side accounts in its own file's source set.
			expect(normalized?.lineAccounting).toEqual({
				production: lineAccount(1, 14, 14),
				test: lineAccount(1, 14, 14),
			});
			expect(
				normalized?.metrics.find(
					(metric) => metric.id === "provider.jscpd.duplication.affected-code-lines.test",
				),
			).toMatchObject({ value: 14, numerator: 14, denominator: 14 });
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"stages only the selected files, never an unselected clone",
		async () => {
			const files = {
				"a.ts": TOTAL_FUNCTION,
				"b.ts": TOTAL_FUNCTION,
				"c.ts": TOTAL_FUNCTION,
			};
			await withConformanceWorkspace(
				files,
				async (view) => {
					// The staged copy holds exactly the selection — c.ts never reaches the tool.
					expect((await readdir(view.stagedRoot)).sort()).toEqual(["a.ts", "b.ts"]);
					const adapter = await runJscpdAdapter(view, { modes: ["exact"] });
					const outcome = adapter.outcomes[0];
					expect(outcome?.state).toBe("complete");
					if (outcome?.state !== "complete") {
						return;
					}
					expect(outcome.coverage.analyzedFiles).toEqual(["a.ts", "b.ts"]);
					const normalized = normalizeJscpdReport(outcome.report, [
						{ path: "a.ts", sourceSet: "production", text: files["a.ts"] ?? "" },
						{ path: "b.ts", sourceSet: "production", text: files["b.ts"] ?? "" },
					]);
					expect(normalized.cloneEvidence).toEqual([
						pairEvidence("exact", locationOf("a.ts", 1, 14), locationOf("b.ts", 1, 14)),
					]);
					for (const member of normalized.cloneEvidence.flatMap((entry) => entry.members)) {
						expect(member.path).not.toBe("c.ts");
					}
				},
				productionSelection(["a.ts", "b.ts"]),
			);
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"ignores target-owned provider configuration over a no-dependency, non-Git workspace",
		async () => {
			// A hostile ancestor config that would empty the analysis if it were trusted:
			// ignore every staged file and raise the token threshold to the sky.
			const files = {
				".jscpd.json": JSON.stringify({
					ignore: ["**/*.ts"],
					minTokens: 9_999_999,
					reporters: ["consoleFull"],
				}),
				"a.ts": TOTAL_FUNCTION,
				"b.ts": fixtureTexts("exact")["b.ts"] ?? "",
			};
			await withConformanceWorkspace(
				files,
				async (view, root) => {
					const adapter = await runJscpdAdapter(view, { modes: ["exact"] });
					const outcome = adapter.outcomes[0];
					expect(outcome?.state).toBe("complete");
					if (outcome?.state !== "complete") {
						return;
					}
					// The owned empty config wins: both files stay sources and the pair is found.
					expect(outcome.report.statistics.total.sources).toBe(2);
					expect(outcome.report.statistics.total.clones).toBe(1);
					// The target workspace holds exactly its authored files — no dependencies,
					// no manifests, no Git needed or consulted, and nothing written back.
					expect((await readdir(root)).sort()).toEqual([".jscpd.json", "a.ts", "b.ts"]);
				},
				// The staged selection is the two sources — the target's own config file
				// is never a selected source (discovery would never classify it as one).
				productionSelection(["a.ts", "b.ts"]),
			);
		},
	);

	test.skipIf(!TOOL_AVAILABLE)("unions within-file duplicated content once per file", async () => {
		const run = await runConformanceAdapter({ "x.ts": `${TOTAL_FUNCTION}\n${TOTAL_FUNCTION}` });
		expect(requireComplete(run, "exact").coverage.analyzedFiles).toEqual(["x.ts"]);
		const normalized = run.normalizedOf("exact");
		expect(normalized?.cloneEvidence).toEqual([
			pairEvidence("exact", locationOf("x.ts", 1, 14), locationOf("x.ts", 16, 29)),
		]);
		// Both members are the same file: the union counts its covered code lines once.
		expect(normalized?.lineAccounting.production).toEqual(lineAccount(1, 28, 28));
	});
});
