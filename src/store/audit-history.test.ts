/**
 * Audit-history provenance and compatible-series tests (plan `pl-43c5`
 * step 8, trellis-ab01) — the AC set for `src/store/` persistence and
 * selection: stored reports round-trip provider provenance and evidence
 * without loss; trend/baseline selection reuses the step-6 scored-basis
 * verdicts (advisory-only provider changes never fragment a series;
 * changed scored measurements or scoring bases start distinct ones;
 * pre-provider rows keep trending under their original interpretation);
 * foreign/corrupt rows never silently imply compatibility (the storage-side
 * cases live in `audit-history-storage.test.ts`). Real temp-file SQLite,
 * no mocks.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	evidenceReport,
	jscpdAnalysis,
	nativeComplexityAnalysis,
	preProviderReport,
} from "../compare/fixtures.ts";
import {
	type AuditReport,
	auditReportSchema,
	type EvidenceArea,
	type ReportAnalysis,
	SCHEMA_VERSION,
} from "../contract/index.ts";
import {
	decodedStoredReport,
	openStore,
	repoIdentity,
	type Store,
	type StoredAuditRun,
} from "./index.ts";

/** Root a fixture report at a real directory with a pinned identity and audit time. */
function rooted(report: AuditReport, root: string, auditedAt: string): AuditReport {
	return auditReportSchema.parse({
		...report,
		repo: { root, identity: "history-fixture" },
		run: { auditedAt },
	});
}

/** The repository identity a rooted report persists under. */
function identityOf(report: AuditReport): string {
	return repoIdentity(report.repo.root, report.repo.identity);
}

/** A second, unavailable external provider entry (the §16.2 gap-state matrix). */
const unavailableKnip: ReportAnalysis = {
	provider: {
		kind: "external",
		id: "knip",
		toolVersion: "1.0.0",
		adapterVersion: "0.1.0",
		mode: "entry-files",
		options: {},
	},
	state: "unavailable",
	scoring: "advisory",
	metricIds: [],
	reason: "the pinned tool is not installed",
};

/** The §6.4 report a stored run's `report_json` decodes to. */
function storedAuditReportOf(run: StoredAuditRun): AuditReport {
	const decoded = decodedStoredReport(run);
	if (decoded === null) throw new Error(`stored run ${run.id} must decode to a §6.4 report`);
	return decoded;
}

/** The evidence area of an evidence-carrying report (every fixture here is schema 1.1.0). */
function evidenceOf(report: AuditReport): EvidenceArea {
	if (report.schemaVersion !== SCHEMA_VERSION) {
		throw new Error("expected an evidence-carrying (schema 1.1.0) report");
	}
	return report.evidence;
}

describe("audit history provenance and compatible series", () => {
	let dir: string;
	let store: Store;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "trellis-audit-history-"));
		store = openStore(join(dir, "trellis.db"));
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("insertAuditRun round-trips provider provenance and evidence without loss", () => {
		const report = rooted(
			evidenceReport([nativeComplexityAnalysis(), jscpdAnalysis(), unavailableKnip]),
			dir,
			"2026-07-01T00:00:00.000Z",
		);
		store.insertAuditRun(report);

		const latest = store.latestAuditRun(identityOf(report));
		expect(latest).not.toBeNull();
		if (!latest) return;
		// The full evidence area — provider identity, analysis identity,
		// observed coverage, namespaced metrics/findings, gap states —
		// survives the render → persist → read round-trip without loss.
		const decoded = storedAuditReportOf(latest);
		expect(evidenceOf(decoded)).toEqual(evidenceOf(report));
		expect(decodedStoredReport(latest)).toEqual(report);
	});

	test("an advisory-only provider change never fragments the native score series", () => {
		const native = rooted(
			evidenceReport([nativeComplexityAnalysis()], { index: 30 }),
			dir,
			"2026-07-01T00:00:00.000Z",
		);
		const added = rooted(
			evidenceReport([jscpdAnalysis(), nativeComplexityAnalysis()], { index: 25 }),
			dir,
			"2026-07-02T00:00:00.000Z",
		);
		const upgraded = rooted(
			evidenceReport([jscpdAnalysis({ toolVersion: "5.3.0" }), nativeComplexityAnalysis()], {
				index: 20,
			}),
			dir,
			"2026-07-03T00:00:00.000Z",
		);
		const removed = rooted(
			evidenceReport([nativeComplexityAnalysis()], { index: 15 }),
			dir,
			"2026-07-04T00:00:00.000Z",
		);
		// The next audit drops the advisory provider again — it is the
		// reference, not a stored row (the read happens before the write).
		for (const report of [native, added, upgraded]) store.insertAuditRun(report);

		const identity = identityOf(native);
		// The series anchored at the latest run keeps every point: adding,
		// upgrading, or removing an advisory provider is not a scored-basis
		// change (§16.6), so the native score history never fragments.
		const series = store.compatibleAuditRuns(identity, removed);
		expect(series.map((run) => run.sloppinessIndex)).toEqual([30, 25, 20]);
		expect(store.sloppinessTrend(identity, removed).map((point) => point.index)).toEqual([
			30, 25, 20,
		]);
		// The baseline for the next audit is still the latest compatible run —
		// the advisory jscpd upgrade on it never fragments the selection.
		const prior = store.latestCompatibleRun(identity, removed);
		expect(prior?.sloppinessIndex).toBe(20);
		expect(prior?.auditedAt).toBe("2026-07-03T00:00:00.000Z");
	});

	test("a changed scored measurement starts a distinct series, and selection walks back", () => {
		const before = rooted(
			evidenceReport([nativeComplexityAnalysis()], { index: 30 }),
			dir,
			"2026-07-01T00:00:00.000Z",
		);
		// Same core versions, but the scored analysis's recorded producer
		// semantics changed (a different pinned tool): the version triple
		// alone never establishes comparable measurements.
		const altered = rooted(
			evidenceReport([nativeComplexityAnalysis({ toolVersion: "9.9.9" })], { index: 5 }),
			dir,
			"2026-07-02T00:00:00.000Z",
		);
		const after = rooted(
			evidenceReport([nativeComplexityAnalysis()], { index: 20 }),
			dir,
			"2026-07-03T00:00:00.000Z",
		);
		// `after` is the next audit — the reference, not a stored row.
		for (const report of [before, altered]) store.insertAuditRun(report);

		const identity = identityOf(before);
		// Anchored at the next audit, the altered run is excluded — never a
		// silent false trend across the changed scored measurement — and
		// the baseline walk skips it back to the latest compatible run,
		// rather than accepting the latest row blindly.
		expect(store.compatibleAuditRuns(identity, after).map((run) => run.sloppinessIndex)).toEqual([
			30,
		]);
		const prior = store.latestCompatibleRun(identity, after);
		expect(prior?.sloppinessIndex).toBe(30);
		expect(prior?.auditedAt).toBe("2026-07-01T00:00:00.000Z");
		// A run stored on the altered basis anchors its own distinct series.
		expect(store.compatibleAuditRuns(identity, altered).map((run) => run.sloppinessIndex)).toEqual([
			5,
		]);
	});

	test("a changed scoring basis (declared scored analyses) never becomes one trend", () => {
		const one = rooted(
			evidenceReport(
				[
					nativeComplexityAnalysis(),
					nativeComplexityAnalysis({ id: "trellis.erosion", metricIds: ["erosion.todo-count"] }),
				],
				{ index: 40 },
			),
			dir,
			"2026-07-01T00:00:00.000Z",
		);
		const two = rooted(
			evidenceReport([nativeComplexityAnalysis()], { index: 10 }),
			dir,
			"2026-07-02T00:00:00.000Z",
		);
		store.insertAuditRun(one);
		store.insertAuditRun(two);

		const identity = identityOf(one);
		// Different scored analysis sets (and scored metric catalogs): the
		// score's inputs are not the same set, so neither anchors a series
		// containing the other.
		expect(store.compatibleAuditRuns(identity, one).map((run) => run.sloppinessIndex)).toEqual([
			40,
		]);
		expect(store.compatibleAuditRuns(identity, two).map((run) => run.sloppinessIndex)).toEqual([
			10,
		]);
		expect(store.latestCompatibleRun(identity, two)?.sloppinessIndex).toBe(10);
	});

	test("pre-provider rows keep loading and trending with their original interpretation", () => {
		const early = rooted(
			preProviderReport(undefined, { index: 40 }),
			dir,
			"2026-07-01T00:00:00.000Z",
		);
		const later = rooted(
			preProviderReport(undefined, { index: 35 }),
			dir,
			"2026-07-02T00:00:00.000Z",
		);
		const current = rooted(
			evidenceReport([jscpdAnalysis(), nativeComplexityAnalysis()], { index: 25 }),
			dir,
			"2026-07-03T00:00:00.000Z",
		);
		for (const report of [early, later, current]) store.insertAuditRun(report);

		const identity = identityOf(early);
		// The pre-provider rows read as schema 1.0.0, never relabeled as
		// carrying provider provenance…
		const rows = store.auditRuns(identity);
		expect(rows.map((run) => storedAuditReportOf(run).schemaVersion)).toEqual([
			"1.0.0",
			"1.0.0",
			"1.1.0",
		]);
		// …and the series anchored at the current run spans them: the scored
		// measurement body is unchanged across the additive schema span and
		// the advisory jscpd evidence, so the native score history continues.
		expect(store.compatibleAuditRuns(identity, current).map((run) => run.sloppinessIndex)).toEqual([
			40, 35, 25,
		]);
	});

	test("a gap-state advisory analysis never fragments a series (partial analyses trend)", () => {
		const complete = rooted(
			evidenceReport([nativeComplexityAnalysis()], { index: 20 }),
			dir,
			"2026-07-01T00:00:00.000Z",
		);
		const partial = rooted(
			evidenceReport([jscpdAnalysis({ state: "incomplete" }), nativeComplexityAnalysis()], {
				index: 18,
			}),
			dir,
			"2026-07-02T00:00:00.000Z",
		);
		store.insertAuditRun(complete);
		store.insertAuditRun(partial);

		const identity = identityOf(complete);
		// An advisory analysis that ran partially degrades the evidence, not
		// the scored basis: the run still trends (§16.2), and its stored
		// report carries the gap — the native headline stays complete.
		const trend = store.sloppinessTrend(identity, partial);
		expect(trend.map((point) => point.index)).toEqual([20, 18]);
		expect(trend[1]?.partial).toBe(false);
		expect(trend[1]?.completeness).toBe("complete");
		const priorRow = store.latestCompatibleRun(identity, partial);
		expect(priorRow).not.toBeNull();
		if (priorRow) {
			const decoded = storedAuditReportOf(priorRow);
			const jscpd = evidenceOf(decoded).analyses.find((entry) => entry.provider.id === "jscpd");
			expect(jscpd?.state).toBe("incomplete");
		}
	});
});
