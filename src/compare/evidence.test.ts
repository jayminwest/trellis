import { describe, expect, test } from "bun:test";
import type { Finding } from "../contract/index.ts";
import { compareEvidence } from "./evidence.ts";
import {
	completeMetric,
	evidenceReport,
	jscpdAnalysis,
	nativeComplexityAnalysis,
	preProviderReport,
} from "./fixtures.ts";

/**
 * Evidence-basis comparison (SPEC §16.6 — trellis-bd0c): per measurement,
 * over the recorded analysis identity. Producer and scope semantics gate the
 * evidence diff; content provenance (a source revision) never does; absence
 * reads as unrequested; partial or absent evidence is never diffed as churn.
 */

function provider(evidence: ReturnType<typeof compareEvidence>, id: string) {
	const found = evidence.providers.find((provider) => provider.providerId === id);
	if (found === undefined) throw new Error(`provider ${id} not carried on either side`);
	return found;
}

function clonePair(path: string): Finding {
	return {
		kind: "provider.jscpd.clone-pair",
		path,
		range: { start: { line: 3 }, end: { line: 17 } },
		summary: `normalized clone pair at ${path}`,
	};
}

describe("compareEvidence identical basis", () => {
	test("diffs namespaced metrics and findings for identical external analyses", () => {
		const baseline = evidenceReport([nativeComplexityAnalysis(), jscpdAnalysis()]);
		const current = evidenceReport([
			nativeComplexityAnalysis(),
			jscpdAnalysis({
				metrics: [completeMetric("provider.jscpd.pairs", 2)],
				findings: [clonePair("src/b.ts")],
			}),
		]);
		const jscpd = provider(compareEvidence(baseline, current), "jscpd");
		expect(jscpd.status).toBe("comparable");
		expect(jscpd.reasons).toEqual([]);
		expect(jscpd.caveats).toEqual([]);
		expect(jscpd.baseline).toEqual({ state: "complete", scoring: "advisory" });
		expect(jscpd.metrics?.find((delta) => delta.id === "provider.jscpd.pairs")?.delta).toBe(1);
		expect(jscpd.findings?.new.map((finding) => finding.path)).toEqual(["src/b.ts"]);
		expect(jscpd.findings?.resolved.map((finding) => finding.path)).toEqual(["src/a.ts"]);
		expect(jscpd.findings?.persistent).toEqual([]);
	});

	test("a changed source revision is the expected input: content provenance is a caveat, never a refusal", () => {
		const baseline = evidenceReport([jscpdAnalysis(), nativeComplexityAnalysis()]);
		const current = evidenceReport([
			jscpdAnalysis({ fingerprintSeed: "b", metrics: [completeMetric("provider.jscpd.pairs", 5)] }),
			nativeComplexityAnalysis({ fingerprintSeed: "b" }),
		]);
		const evidence = compareEvidence(baseline, current);
		const jscpd = provider(evidence, "jscpd");
		expect(jscpd.status).toBe("comparable");
		expect(jscpd.caveats.map((caveat) => caveat.code)).toEqual(["input-revision-changed"]);
		expect(jscpd.metrics?.find((delta) => delta.id === "provider.jscpd.pairs")?.delta).toBe(4);
		// Native content changes are the comparison's subject matter, not a per-entry caveat.
		expect(provider(evidence, "trellis.complexity").caveats).toEqual([]);
	});
});

describe("compareEvidence changed measurement basis", () => {
	test("a changed pinned tool version is a noncomparable provider dimension without diffs", () => {
		const baseline = evidenceReport([jscpdAnalysis()]);
		const current = evidenceReport([jscpdAnalysis({ toolVersion: "5.3.0" })]);
		const jscpd = provider(compareEvidence(baseline, current), "jscpd");
		expect(jscpd.status).toBe("noncomparable");
		// The tool and its parser moved together: both components are named.
		expect(jscpd.reasons.map((reason) => reason.code)).toEqual([
			"provider-identity",
			"parser-identity",
		]);
		expect(jscpd.metrics).toBeUndefined();
		expect(jscpd.findings).toBeUndefined();
	});

	test("a changed parser alone is a noncomparable provider dimension", () => {
		const current = evidenceReport([
			jscpdAnalysis({ parser: { engine: "jscpd.tokenizer", version: "6.0.0" } }),
		]);
		const jscpd = provider(compareEvidence(evidenceReport([jscpdAnalysis()]), current), "jscpd");
		expect(jscpd.status).toBe("noncomparable");
		expect(jscpd.reasons.map((reason) => reason.code)).toEqual(["parser-identity"]);
		expect(jscpd.reasons[0]?.message).toContain("jscpd.tokenizer");
	});

	test("changed normalized analysis options are a noncomparable provider dimension", () => {
		const current = evidenceReport([jscpdAnalysis({ analysisOptions: { "min-tokens": 60 } })]);
		const jscpd = provider(compareEvidence(evidenceReport([jscpdAnalysis()]), current), "jscpd");
		expect(jscpd.reasons.map((reason) => reason.code)).toEqual(["analysis-options"]);
		expect(jscpd.metrics).toBeUndefined();
	});

	test("a changed provider option set is a noncomparable provider dimension", () => {
		const current = evidenceReport([
			jscpdAnalysis({ providerOptions: { "ignore-identifiers": false } }),
		]);
		const jscpd = provider(compareEvidence(evidenceReport([jscpdAnalysis()]), current), "jscpd");
		expect(jscpd.reasons.map((reason) => reason.code)).toEqual(["provider-identity"]);
	});

	test("a changed selection is a noncomparable scope dimension, separate from content provenance", () => {
		const changedPaths = evidenceReport([jscpdAnalysis({ paths: ["src/a.ts", "src/b.ts"] })]);
		const byPaths = provider(
			compareEvidence(evidenceReport([jscpdAnalysis()]), changedPaths),
			"jscpd",
		);
		expect(byPaths.status).toBe("noncomparable");
		expect(byPaths.reasons.map((reason) => reason.code)).toEqual(["selection"]);
		expect(byPaths.reasons[0]?.message).toContain("selected file sets differ (1 vs 2 files)");

		const changedSets = evidenceReport([jscpdAnalysis({ sourceSets: ["production", "test"] })]);
		const bySets = provider(
			compareEvidence(evidenceReport([jscpdAnalysis()]), changedSets),
			"jscpd",
		);
		expect(bySets.reasons.map((reason) => reason.code)).toEqual(["selection"]);
		expect(bySets.reasons[0]?.message).toContain("source sets differ");
	});
});

describe("compareEvidence states and absence", () => {
	test("an incomplete analysis never fabricates diffs", () => {
		const current = evidenceReport([jscpdAnalysis({ state: "incomplete" })]);
		const jscpd = provider(compareEvidence(evidenceReport([jscpdAnalysis()]), current), "jscpd");
		expect(jscpd.status).toBe("noncomparable");
		expect(jscpd.reasons.map((reason) => reason.code)).toEqual(["state-gap"]);
		expect(jscpd.reasons[0]?.message).toContain("the current analysis is incomplete");
		expect(jscpd.metrics).toBeUndefined();
	});

	test("an unavailable analysis on the baseline is a located gap, never churn", () => {
		const baseline = evidenceReport([jscpdAnalysis({ state: "unavailable" })]);
		const jscpd = provider(compareEvidence(baseline, evidenceReport([jscpdAnalysis()])), "jscpd");
		expect(jscpd.status).toBe("noncomparable");
		expect(jscpd.reasons[0]?.message).toContain("the baseline analysis is unavailable");
	});

	test("a provider absent on one side reads as unrequested, never as a regression", () => {
		const baseline = evidenceReport([jscpdAnalysis()]);
		const current = evidenceReport([nativeComplexityAnalysis()]);
		const jscpd = provider(compareEvidence(baseline, current), "jscpd");
		expect(jscpd.status).toBe("absent-on-current");
		expect(jscpd.reasons.map((reason) => reason.code)).toEqual(["not-carried"]);
		expect(jscpd.current).toEqual({ state: "unrequested", scoring: null });
		expect(jscpd.metrics).toBeUndefined();
	});

	test("an explicitly unrequested provider on both sides is an explicit absence", () => {
		const baseline = evidenceReport([jscpdAnalysis({ state: "unrequested" })]);
		const current = evidenceReport([jscpdAnalysis({ state: "unrequested" })]);
		const jscpd = provider(compareEvidence(baseline, current), "jscpd");
		expect(jscpd.status).toBe("unrequested");
		expect(jscpd.reasons).toEqual([]);
		expect(jscpd.metrics).toBeUndefined();
	});

	test("an unrequested provider becoming requested still reads as absent, not new churn", () => {
		const baseline = evidenceReport([jscpdAnalysis({ state: "unrequested" })]);
		const current = evidenceReport([jscpdAnalysis()]);
		const jscpd = provider(compareEvidence(baseline, current), "jscpd");
		expect(jscpd.status).toBe("absent-on-baseline");
		expect(jscpd.reasons[0]?.message).toContain("does not request");
	});

	test("a pre-provider report carries no provider evidence at all", () => {
		const evidence = compareEvidence(preProviderReport(), preProviderReport());
		expect(evidence.providers).toEqual([]);
	});
});

describe("compareEvidence native entries and determinism", () => {
	test("native entries compare by recorded identity without duplicating report evidence", () => {
		const evidence = compareEvidence(
			evidenceReport([nativeComplexityAnalysis()]),
			evidenceReport([nativeComplexityAnalysis()]),
		);
		const native = provider(evidence, "trellis.complexity");
		expect(native.status).toBe("comparable");
		expect(native.reasons).toEqual([]);
		// Native values live in the report's metrics/findings areas — never diffed per entry.
		expect(native.metrics).toBeUndefined();
		expect(native.findings).toBeUndefined();
	});

	test("a native entry with a changed selection is noncomparable by recorded identity", () => {
		const current = evidenceReport([nativeComplexityAnalysis({ paths: ["src/a.ts", "src/c.ts"] })]);
		const native = provider(
			compareEvidence(evidenceReport([nativeComplexityAnalysis()]), current),
			"trellis.complexity",
		);
		expect(native.status).toBe("noncomparable");
		expect(native.reasons.map((reason) => reason.code)).toEqual(["selection"]);
	});

	test("orders providers by id and is byte-identical on repeated comparison", () => {
		const baseline = evidenceReport([nativeComplexityAnalysis(), jscpdAnalysis()]);
		const current = evidenceReport([
			nativeComplexityAnalysis(),
			jscpdAnalysis({ state: "incomplete", toolVersion: "5.3.0", paths: ["src/z.ts"] }),
		]);
		const first = compareEvidence(baseline, current);
		const second = compareEvidence(baseline, current);
		expect(JSON.stringify(second)).toBe(JSON.stringify(first));
		expect(first.providers.map((provider) => provider.providerId)).toEqual([
			"jscpd",
			"trellis.complexity",
		]);
	});
});
