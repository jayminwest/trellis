/**
 * Bounded conformance for the dependency-cruiser provider over the
 * authored architecture controls (plan `pl-43c5` step 22, trellis-adbf —
 * acceptance 2–5).
 *
 * Every control runs through the real pinned tool over a staged view —
 * resolver → controlled process runner → staged workspace — and asserts
 * **explicit expected evidence**: the normalized violations with their
 * edge flavors (runtime and type-only never merged), the preserved cycle
 * paths, the allowed-boundary exemption as visible evidence, the stub
 * separation, and the full-coverage assertion over the staged selection.
 * A successful empty graph cannot pass these controls (coverage is the
 * point), and repeated runs must normalize identically. Nothing here
 * scores evidence or displaces the native graph analyzers.
 */
import { describe, expect, test } from "bun:test";
import type { Finding } from "../../contract/index.ts";
import { analysisIdentitySchema, providerIdentitySchema } from "../../contract/index.ts";
import { resolvePinnedTool } from "../resolve.ts";
import {
	type ArchitectureConformanceRun,
	requireCompleteCruise,
	runArchitectureConformance,
} from "./conformance.ts";

/** Real-binary tests run only where the pinned artifact resolved on this host. */
const TOOL_AVAILABLE = resolvePinnedTool("dependency-cruiser").state === "available";

/** One finding's compact projection: kind, path, to, edges. */
function compact(finding: Finding) {
	const facts = finding.facts as Record<string, unknown>;
	return {
		kind: finding.kind,
		path: finding.path,
		to: facts.to,
		edges: facts.edges,
		violationType: facts.violationType,
	};
}

/** The normalized findings of one run, fails fast when the run did not complete. */
function findingsOf(run: ArchitectureConformanceRun): readonly Finding[] {
	return requireCompleteCruise(run).normalized.findings;
}

describe("runDependencyCruiserAdapter conformance (pinned controls)", () => {
	test.skipIf(!TOOL_AVAILABLE)(
		"evaluates the boundary, runtime-cycle, type-only-cycle and unresolved controls with separated edges",
		async () => {
			const run = await runArchitectureConformance();
			const { adapter, normalized } = requireCompleteCruise(run);
			expect(adapter.outcome.state).toBe("complete");

			expect(normalized.violations).toHaveLength(3);
			expect(findingsOf(run).map(compact)).toEqual([
				{
					kind: "provider.dependency-cruiser.allowed-dependency",
					path: "src/domain/bad.ts",
					to: "src/ui/view.ts",
					edges: undefined,
					violationType: undefined,
				},
				{
					kind: "provider.dependency-cruiser.no-runtime-cycles",
					path: "src/cycle-a.ts",
					to: "src/cycle-b.ts",
					edges: ["runtime"],
					violationType: "cycle",
				},
				{
					kind: "provider.dependency-cruiser.no-type-only-cycles",
					path: "src/type-a.ts",
					to: "src/type-b.ts",
					edges: ["type-only"],
					violationType: "cycle",
				},
				{
					kind: "provider.dependency-cruiser.no-unresolved-imports",
					path: "src/main.ts",
					to: "./missing.ts",
					edges: ["runtime"],
					violationType: "unresolved",
				},
			]);

			// The forbidden-boundary control is exempted (next test) — the
			// domain-to-ui violation never appears; the allowed shared import
			// and the entry exports are negative controls, not findings.
			const kinds = findingsOf(run).map((finding) => finding.kind);
			expect(kinds).not.toContain("provider.dependency-cruiser.domain-must-not-import-ui");
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"exempts a forbidden dependency through an allowed boundary as visible evidence, never silently",
		async () => {
			const run = await runArchitectureConformance();
			const { normalized } = requireCompleteCruise(run);
			expect(normalized.allowedDependencies).toEqual([
				{
					rule: "allow-bad-view",
					from: "src/domain/bad.ts",
					to: "src/ui/view.ts",
					specifier: "../ui/view.ts",
				},
			]);
			const allowed = findingsOf(run).find(
				(finding) => finding.kind === "provider.dependency-cruiser.allowed-dependency",
			);
			expect(allowed).toBeDefined();
			expect(allowed?.summary).toContain("allow-bad-view");
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"preserves builtin, external and unresolved-local stubs separately from production nodes",
		async () => {
			const run = await runArchitectureConformance();
			const outcome = completeOutcome(run);
			expect(outcome.coverage.stubs).toEqual([
				{ source: "./missing.ts", kind: "unresolved-local" },
				{ source: "fs", kind: "builtin" },
				{ source: "zod", kind: "external" },
			]);
			const stubs = metricOf(run, "provider.dependency-cruiser.graph.stubs");
			expect(stubs?.value).toBe(3);
			expect(stubs?.detail).toEqual({
				classes: { builtin: 1, external: 1, "unresolved-local": 1 },
			});
			// The external import is not a violation: the staged source view
			// resolves no package bodies, so externals stay stub evidence.
			expect(findingsOf(run).some((finding) => finding.summary.includes("zod"))).toBe(false);
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"asserts full coverage of the staged selection — an empty graph can never complete",
		async () => {
			const run = await runArchitectureConformance();
			const outcome = completeOutcome(run);
			expect(outcome.coverage.selectedFiles).toBe(12);
			expect(outcome.coverage.representedFiles).toHaveLength(12);
			expect(outcome.coverage.missingFiles).toEqual([]);
			const nodes = metricOf(run, "provider.dependency-cruiser.graph.nodes");
			expect(nodes?.state).toBe("complete");
			expect(nodes?.value).toBe(12);
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"repeats to identical normalized evidence and identity across runs",
		async () => {
			const first = await runArchitectureConformance();
			const second = await runArchitectureConformance();
			const a = requireCompleteCruise(first);
			const b = requireCompleteCruise(second);
			expect(a.normalized.findings).toEqual(b.normalized.findings);
			expect(a.normalized.metrics).toEqual(b.normalized.metrics);
			expect(a.normalized.violations).toEqual(b.normalized.violations);
			expect(a.normalized.allowedDependencies).toEqual(b.normalized.allowedDependencies);
			expect(JSON.stringify(a.adapter.outcome)).toEqual(JSON.stringify(b.adapter.outcome));
			// Identity validates against the contract and repeats byte-identically.
			expect(providerIdentitySchema.parse(a.adapter.outcome.provider)).toEqual(
				providerIdentitySchema.parse(b.adapter.outcome.provider),
			);
			expect(analysisIdentitySchema.parse(completeOutcome(first).analysis)).toEqual(
				analysisIdentitySchema.parse(completeOutcome(second).analysis),
			);
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"records the parser context it resolved, never an assumed compiler version",
		async () => {
			const run = await runArchitectureConformance();
			const { adapter } = requireCompleteCruise(run);
			const parser = adapter.parser;
			if (!("version" in parser)) {
				throw new Error("a completed cruise records the parser it resolved");
			}
			expect(parser.engine).toBe("dependency-cruiser.typescript");
			expect(parser.version).toMatch(/^\d+\.\d+\.\d+$/);
			const analysis = analysisIdentitySchema.parse(completeOutcome(run).analysis);
			expect(analysis.parser).toEqual({
				engine: "dependency-cruiser.typescript",
				version: parser.version,
			});
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"a zero-rule request is valid configuration that claims no architecture verdicts",
		async () => {
			const run = await runArchitectureConformance(undefined, { rules: [] });
			const { normalized } = requireCompleteCruise(run);
			expect(normalized.violations).toEqual([]);
			expect(normalized.findings).toEqual([]);
			expect(metricOf(run, "provider.dependency-cruiser.violations")?.value).toBe(0);
			// Zero rules never reads as coherence: the rule count rides identity.
			const options = completeOutcome(run).provider.options;
			expect(options["architecture-rule-count"]).toBe(0);
			expect(options["architecture-policy-digest"]).toMatch(/^sha256:[0-9a-f]{64}$/);
		},
	);
});

/** The complete cruise outcome of a run (fails fast otherwise). */
function completeOutcome(run: ArchitectureConformanceRun) {
	const outcome = run.adapter.outcome;
	if (outcome.state !== "complete") {
		throw new Error(`expected a complete cruise, got "${outcome.state}"`);
	}
	return outcome;
}

/** One metric of a run's normalized evidence by id. */
function metricOf(run: ArchitectureConformanceRun, id: string) {
	return requireCompleteCruise(run).normalized.metrics.find((metric) => metric.id === id);
}
