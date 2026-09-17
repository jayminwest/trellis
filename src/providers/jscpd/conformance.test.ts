/**
 * Bounded conformance for the jscpd provider over the authored research
 * controls (plan `pl-43c5` — trellis-b0ec, step 14, acceptance 1 and 5).
 *
 * Every control runs through the real pinned binary over a staged view —
 * resolve → controlled process → staged workspace — and asserts **explicit
 * expected evidence**: the normalized clone units, their locations, and
 * the trellis-owned line accounting. The ambiguous idiomatic control is
 * retained as a recorded lead, never as ground truth. The bounded corpus
 * repeats three times and must normalize to identical evidence (the
 * volatile detection date is excluded by design), with identical
 * provider/analysis identity across repeats and distinct options across
 * modes. Observations, environment, and the failure matrix live in
 * `docs/jscpd-conformance.md`; nothing here scores or promotes evidence.
 */
import { describe, expect, test } from "bun:test";
import {
	analysisIdentitySchema,
	CLONE_MATCH_MODES,
	type CloneGroupEvidence,
	type ClonePair,
	providerIdentitySchema,
} from "../../contract/index.ts";
import { resolvePinnedTool } from "../resolve.ts";
import {
	CONFORMANCE_CORPUS,
	type ConformanceRun,
	fixtureTexts,
	groupEvidence,
	lineAccount,
	locationOf,
	pairEvidence,
	requireComplete,
	runConformanceAdapter,
} from "./conformance.ts";
import type { JscpdNormalizedEvidence } from "./normalize.ts";

/** Real-binary tests run only where the pinned artifact resolved on this host. */
const TOOL_AVAILABLE = resolvePinnedTool("jscpd").state === "available";

/** The metric table of one normalized run: id, value, numerator, denominator. */
function metricTable(normalized: JscpdNormalizedEvidence | undefined): unknown[][] {
	if (normalized === undefined) {
		throw new Error("expected normalized evidence");
	}
	return normalized.metrics.map((metric) => [
		metric.id,
		metric.value,
		metric.numerator ?? null,
		metric.denominator ?? null,
	]);
}

describe("runJscpdAdapter conformance (pinned controls)", () => {
	test.skipIf(!TOOL_AVAILABLE)(
		"reports the identical-copy control as one exact pair in every mode",
		async () => {
			const run = await runConformanceAdapter(fixtureTexts("exact"));
			for (const mode of CLONE_MATCH_MODES) {
				const outcome = requireComplete(run, mode);
				expect(outcome.coverage).toEqual({
					selectedFiles: 2,
					reportedSources: 2,
					omittedFromSourceStatistics: 0,
					analyzedFiles: ["a.ts", "b.ts"],
				});
				const normalized = run.normalizedOf(mode);
				expect(normalized?.cloneEvidence).toEqual([
					pairEvidence("exact", locationOf("a.ts", 1, 14), locationOf("b.ts", 1, 14)),
				]);
				expect(normalized?.lineAccounting.production).toEqual(lineAccount(2, 28, 28));
			}
			// The raw facts of the pinned tool's record are preserved on the finding.
			expect(run.normalizedOf("exact")?.findings[0]).toMatchObject({
				kind: "provider.jscpd.clone-pair",
				path: "a.ts",
				summary: "jscpd exact clone pair (a.ts:1-14 ~ b.ts:1-14)",
				facts: {
					matchMode: "exact",
					rawKind: "exact",
					format: "typescript",
					lines: 14,
					tokens: 88,
				},
			});
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"separates the renamed control into absent-exact, present-normalized evidence",
		async () => {
			const run = await runConformanceAdapter(fixtureTexts("renamed"));
			expect(requireComplete(run, "exact").coverage.analyzedFiles).toEqual(["a.ts", "b.ts"]);
			expect(run.normalizedOf("exact")?.cloneEvidence).toEqual([]);
			for (const mode of ["normalized", "near"] as const) {
				expect(requireComplete(run, mode).coverage.analyzedFiles).toEqual(["a.ts", "b.ts"]);
				const normalized = run.normalizedOf(mode);
				expect(normalized?.cloneEvidence).toEqual([
					pairEvidence("normalized", locationOf("a.ts", 1, 14), locationOf("b.ts", 1, 14)),
				]);
				expect(normalized?.lineAccounting.production).toEqual(lineAccount(2, 28, 28));
			}
			expect(run.normalizedOf("normalized")?.findings[0]?.facts).toMatchObject({
				rawKind: "renamed",
				tokens: 88,
			});
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"separates the edited-copy control into near-miss-only evidence",
		async () => {
			const run = await runConformanceAdapter(fixtureTexts("near"));
			for (const mode of ["exact", "normalized"] as const) {
				expect(requireComplete(run, mode).coverage.analyzedFiles).toEqual(["a.ts", "b.ts"]);
				expect(run.normalizedOf(mode)?.cloneEvidence).toEqual([]);
			}
			const normalized = run.normalizedOf("near");
			// The pinned tool anchors the similar clone at the function keyword (column 8).
			expect(normalized?.cloneEvidence).toEqual([
				pairEvidence("near", locationOf("a.ts", 1, 14, 8), locationOf("b.ts", 1, 15, 8)),
			]);
			expect(normalized?.findings[0]?.facts).toMatchObject({
				rawKind: "similar",
				method: "ast",
				similarity: 0.867,
				lines: 14,
				tokens: 87,
			});
			// a spans 14 code lines, b 15 (the inserted log line) — unioned once per file.
			expect(normalized?.lineAccounting.production).toEqual(lineAccount(2, 29, 29));
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"reports the unrelated control as complete zero evidence, never clean-by-absence",
		async () => {
			const run = await runConformanceAdapter(fixtureTexts("unrelated"));
			for (const mode of CLONE_MATCH_MODES) {
				const outcome = requireComplete(run, mode);
				// Zero findings ride on full asserted coverage, not on an unexamined scope.
				expect(outcome.coverage.analyzedFiles).toEqual(["a.ts", "b.ts"]);
				const normalized = run.normalizedOf(mode);
				expect(normalized?.cloneEvidence).toEqual([]);
				expect(
					normalized?.metrics.find(
						(metric) => metric.id === "provider.jscpd.duplication.clone-pairs",
					),
				).toMatchObject({ state: "complete", value: 0 });
			}
			expect(run.normalizedOf("near")?.lineAccounting.production).toEqual(lineAccount(2, 21, 0));
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"retains the ambiguous idiomatic control as a recorded lead, not ground truth",
		async () => {
			// The spike authors this pair as ambiguous: independent data builders with
			// matching structure. These assertions record what the pinned tool observes
			// (evidence shape and location) and deliberately do not label it a true
			// duplication finding — a lead, not ground truth (docs/jscpd-conformance.md).
			const run = await runConformanceAdapter(fixtureTexts("idiom"));
			expect(requireComplete(run, "exact").coverage.analyzedFiles).toEqual(["a.ts", "b.ts"]);
			expect(run.normalizedOf("exact")?.cloneEvidence).toEqual([]);
			for (const mode of ["normalized", "near"] as const) {
				expect(requireComplete(run, mode).coverage.analyzedFiles).toEqual(["a.ts", "b.ts"]);
				const normalized = run.normalizedOf(mode);
				expect(normalized?.cloneEvidence).toEqual([
					pairEvidence("normalized", locationOf("a.ts", 1, 11), locationOf("b.ts", 1, 11)),
				]);
				expect(normalized?.lineAccounting.production).toEqual(lineAccount(2, 22, 22));
			}
		},
	);
});

describe("runJscpdAdapter conformance (bounded corpus repeat)", () => {
	/** The identical 14-line content shared by five corpus files (the exact group). */
	const EXACT_GROUP = [
		"controls/exact-a.ts",
		"controls/exact-b.ts",
		"controls/near-a.ts",
		"controls/renamed-a.ts",
		"controls/unrelated-a.ts",
	];
	/** The same content plus the renamed copy that normalization equates (the normalized group). */
	const NORMALIZED_GROUP = [
		"controls/exact-a.ts",
		"controls/exact-b.ts",
		"controls/near-a.ts",
		"controls/renamed-a.ts",
		"controls/renamed-b.ts",
		"controls/unrelated-a.ts",
	];

	/** The near-mode pairs as [matchMode, first path, second path], in evidence order. */
	const NEAR_PAIRS: string[][] = [
		["near", "controls/exact-a.ts", "controls/near-b.ts"],
		["near", "controls/exact-b.ts", "controls/near-a.ts"],
		["near", "controls/exact-b.ts", "controls/near-b.ts"],
		["near", "controls/exact-b.ts", "controls/renamed-a.ts"],
		["near", "controls/exact-b.ts", "controls/renamed-b.ts"],
		["near", "controls/exact-b.ts", "controls/unrelated-a.ts"],
		["normalized", "controls/idiom-a.ts", "controls/idiom-b.ts"],
		["near", "controls/near-a.ts", "controls/near-b.ts"],
		["near", "controls/near-a.ts", "controls/renamed-a.ts"],
		["near", "controls/near-a.ts", "controls/renamed-b.ts"],
		["near", "controls/near-a.ts", "controls/unrelated-a.ts"],
		["near", "controls/near-b.ts", "controls/renamed-a.ts"],
		["near", "controls/near-b.ts", "controls/renamed-b.ts"],
		["near", "controls/near-b.ts", "controls/unrelated-a.ts"],
		["near", "controls/renamed-a.ts", "controls/renamed-b.ts"],
		["near", "controls/renamed-a.ts", "controls/unrelated-a.ts"],
		["near", "controls/renamed-b.ts", "controls/unrelated-a.ts"],
		["exact", "tsx/a.tsx", "tsx/b.tsx"],
	];

	test.skipIf(!TOOL_AVAILABLE)(
		"repeats identical normalized evidence over the bounded corpus with stable identities",
		async () => {
			const runs: ConformanceRun[] = [];
			for (let index = 0; index < 3; index += 1) {
				runs.push(await runConformanceAdapter({ ...CONFORMANCE_CORPUS }));
			}
			const first = runs[0];
			if (first === undefined) {
				throw new Error("the repeat runs are missing");
			}
			const selection = Object.keys(CONFORMANCE_CORPUS).sort();
			expect(selection).toHaveLength(12);
			for (const mode of CLONE_MATCH_MODES) {
				const outcome = requireComplete(first, mode);
				expect(outcome.coverage.analyzedFiles).toEqual(selection);
				expect(outcome.analysis.selection.files.map((file) => file.path)).toEqual(selection);
				expect(providerIdentitySchema.parse(outcome.provider)).toEqual(outcome.provider);
				expect(analysisIdentitySchema.parse(outcome.analysis)).toEqual(outcome.analysis);
			}
			// Identities are identical across repeats and distinct across modes (§16.2/§16.6).
			for (const mode of CLONE_MATCH_MODES) {
				const repeated = runs.map((run) => requireComplete(run, mode).analysis);
				expect(repeated[1]).toEqual(repeated[0]);
				expect(repeated[2]).toEqual(repeated[0]);
			}
			expect(requireComplete(first, "near").analysis.options).not.toEqual(
				requireComplete(first, "exact").analysis.options,
			);
			// Every mode's normalized evidence is identical across the three repeats
			// (the volatile detection date never enters the normalized product).
			for (const mode of CLONE_MATCH_MODES) {
				const evidence = runs.map((run) => JSON.stringify(run.normalizedOf(mode)));
				expect(evidence[1]).toBe(evidence[0]);
				expect(evidence[2]).toBe(evidence[0]);
			}
			// Explicit expected evidence per mode (docs/jscpd-conformance.md):
			// exact — one proven group over the five identical copies plus the TSX pair.
			expect(first.normalizedOf("exact")?.cloneEvidence).toEqual([
				groupEvidence(
					"exact",
					EXACT_GROUP.map((path) => locationOf(path, 1, 14)),
				),
				pairEvidence("exact", locationOf("tsx/a.tsx", 1, 7), locationOf("tsx/b.tsx", 1, 7)),
			]);
			expect(metricTable(first.normalizedOf("exact"))).toEqual([
				["provider.jscpd.duplication.affected-code-lines.production", 84, 84, 142],
				["provider.jscpd.duplication.affected-code-lines.test", 0, null, null],
				["provider.jscpd.duplication.clone-groups", 1, null, null],
				["provider.jscpd.duplication.clone-pairs", 1, null, null],
			]);
			// normalized — the group grows by the renamed copy; the idiomatic lead appears.
			expect(first.normalizedOf("normalized")?.cloneEvidence).toEqual([
				groupEvidence(
					"normalized",
					NORMALIZED_GROUP.map((path) => locationOf(path, 1, 14)),
				),
				pairEvidence(
					"normalized",
					locationOf("controls/idiom-a.ts", 1, 11),
					locationOf("controls/idiom-b.ts", 1, 11),
				),
				pairEvidence("exact", locationOf("tsx/a.tsx", 1, 7), locationOf("tsx/b.tsx", 1, 7)),
			]);
			expect(metricTable(first.normalizedOf("normalized"))).toEqual([
				["provider.jscpd.duplication.affected-code-lines.production", 120, 120, 142],
				["provider.jscpd.duplication.affected-code-lines.test", 0, null, null],
				["provider.jscpd.duplication.clone-groups", 1, null, null],
				["provider.jscpd.duplication.clone-pairs", 2, null, null],
			]);
			// near — near matches stay pair-only (never merged into the group), 18 of them.
			const near = first.normalizedOf("near");
			expect(
				near?.cloneEvidence.filter((entry): entry is CloneGroupEvidence => entry.kind === "group"),
			).toEqual([
				groupEvidence(
					"normalized",
					NORMALIZED_GROUP.map((path) => locationOf(path, 1, 14)),
				),
			]);
			expect(
				near?.cloneEvidence
					.filter((entry): entry is ClonePair => entry.kind === "pair")
					.map((entry) => [entry.matchMode, entry.members[0].path, entry.members[1].path]),
			).toEqual(NEAR_PAIRS);
			expect(metricTable(first.normalizedOf("near"))).toEqual([
				["provider.jscpd.duplication.affected-code-lines.production", 135, 135, 142],
				["provider.jscpd.duplication.affected-code-lines.test", 0, null, null],
				["provider.jscpd.duplication.clone-groups", 1, null, null],
				["provider.jscpd.duplication.clone-pairs", 18, null, null],
			]);
		},
	);
});
