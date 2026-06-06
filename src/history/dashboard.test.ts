import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Report } from "../report/index.ts";
import { changesSinceLastRun } from "../report/index.ts";
import { RUBRIC_VERSION } from "../rubric/index.ts";
import type { ScorecardEntry } from "../scoring/index.ts";
import { openStore, type Store } from "../store/index.ts";
import { buildHistory } from "./dashboard.ts";

/** A counted entry shorthand. */
function counted(numerator: number, denominator = 1): ScorecardEntry {
	return { numerator, denominator, rationale: "x" };
}

/** A §6.3-valid report fixture. */
function makeReport(overrides: Partial<Report> = {}): Report {
	return {
		repo: "warren",
		rubricVersion: "1.0.0",
		scoredAt: "2026-06-01T00:00:00.000Z",
		commit: "c0",
		level: 3,
		passRate: 0.75,
		coverage: 0.9,
		apps: { ".": { description: "warren" } },
		criteria: { a: counted(1), b: counted(0) },
		...overrides,
	};
}

/**
 * Insert a sequence of runs for one repo into `store`, embedding each run's §11
 * delta against its predecessor exactly as {@link auditRepo} does, so the stored
 * `report_json` carries `changesSinceLastRun`.
 */
function insertSeq(store: Store, runs: Report[]): void {
	let previous: Report | null = null;
	for (const run of runs) {
		const report: Report = previous
			? { ...run, changesSinceLastRun: changesSinceLastRun(run, previous) }
			: run;
		store.insertRun(report);
		previous = report;
	}
}

describe("buildHistory", () => {
	let store: Store;

	beforeEach(() => {
		store = openStore(":memory:");
	});

	afterEach(() => {
		store.close();
	});

	test("returns an empty dashboard for an empty store, echoing the current rubric", () => {
		const report = buildHistory(store);
		expect(report.fleet).toEqual([]);
		expect(report.repos).toEqual([]);
		expect(report.scope).toEqual({ repo: null, since: null });
		expect(report.rubricVersion).toBe(RUBRIC_VERSION);
	});

	test("fleet snapshot shows each repo's latest run, sorted, with the embedded level delta", () => {
		insertSeq(store, [
			makeReport({ repo: "warren", scoredAt: "2026-06-01T00:00:00.000Z", level: 2 }),
			makeReport({ repo: "warren", scoredAt: "2026-06-02T00:00:00.000Z", level: 4, commit: "c1" }),
		]);
		insertSeq(store, [
			makeReport({ repo: "burrow", scoredAt: "2026-06-01T00:00:00.000Z", level: 3 }),
		]);

		const { fleet } = buildHistory(store);
		expect(fleet.map((e) => e.repo)).toEqual(["burrow", "warren"]);
		const warren = fleet.find((e) => e.repo === "warren");
		expect(warren?.level).toBe(4);
		expect(warren?.commit).toBe("c1");
		expect(warren?.levelDelta).toBe(2); // 4 − 2, from the embedded §11 delta
		expect(warren?.runs).toBe(2);
		// A first run has no prior delta → null level move.
		expect(fleet.find((e) => e.repo === "burrow")?.levelDelta).toBeNull();
	});

	test("per-repo detail carries the run series and the latest §11 delta", () => {
		insertSeq(store, [
			makeReport({
				scoredAt: "2026-06-01T00:00:00.000Z",
				level: 2,
				criteria: { a: counted(0), b: counted(0) },
			}),
			makeReport({
				scoredAt: "2026-06-02T00:00:00.000Z",
				level: 4,
				commit: "c1",
				criteria: { a: counted(1), b: counted(0) },
			}),
		]);

		const detail = buildHistory(store).repos.find((r) => r.repo === "warren");
		expect(detail?.runs.map((r) => r.level)).toEqual([2, 4]);
		expect(detail?.changesSinceLastRun?.netLevelMove).toBe(2);
		expect(detail?.changesSinceLastRun?.attribution).toBe("code");
		expect(detail?.changesSinceLastRun?.transitions.map((t) => [t.criterion, t.kind])).toEqual([
			["a", "fail-to-pass"],
		]);
	});

	test("trends include only criteria that moved, with their full point series", () => {
		insertSeq(store, [
			makeReport({
				scoredAt: "2026-06-01T00:00:00.000Z",
				criteria: { a: counted(1), b: counted(0) },
			}),
			makeReport({
				scoredAt: "2026-06-02T00:00:00.000Z",
				criteria: { a: counted(1), b: counted(1) },
			}),
		]);

		const detail = buildHistory(store).repos.find((r) => r.repo === "warren");
		// `a` held at 1/1 (dropped); only `b` moved.
		expect(detail?.trends.map((t) => t.criterion)).toEqual(["b"]);
		expect(detail?.trends[0]?.points.map((p) => p.status)).toEqual(["fail", "pass"]);
	});

	test("--repo narrows the snapshot and detail to one target", () => {
		insertSeq(store, [makeReport({ repo: "warren" })]);
		insertSeq(store, [makeReport({ repo: "burrow" })]);

		const report = buildHistory(store, { repo: "warren" });
		expect(report.scope.repo).toBe("warren");
		expect(report.fleet.map((e) => e.repo)).toEqual(["warren"]);
		expect(report.repos.map((r) => r.repo)).toEqual(["warren"]);
	});

	test("--since floors the run series and trend window, but the snapshot still shows the latest run", () => {
		insertSeq(store, [
			makeReport({
				scoredAt: "2026-01-01T00:00:00.000Z",
				level: 1,
				criteria: { a: counted(0), b: counted(0) },
			}),
			makeReport({
				scoredAt: "2026-03-01T00:00:00.000Z",
				level: 2,
				criteria: { a: counted(1), b: counted(0) },
			}),
			makeReport({
				scoredAt: "2026-05-01T00:00:00.000Z",
				level: 3,
				commit: "c2",
				criteria: { a: counted(1), b: counted(1) },
			}),
		]);

		const report = buildHistory(store, { since: "2026-04-01T00:00:00.000Z" });
		expect(report.scope.since).toBe("2026-04-01T00:00:00.000Z");
		// Snapshot reflects the latest run overall and its windowed run count (1).
		const snap = report.fleet.find((e) => e.repo === "warren");
		expect(snap?.commit).toBe("c2");
		expect(snap?.runs).toBe(1);
		// Detail series is floored to the single in-window run; no in-window pair → no trends.
		expect(report.repos[0]?.runs.map((r) => r.level)).toEqual([3]);
		expect(report.repos[0]?.trends).toEqual([]);
	});

	test("--repo with no runs in the window drops the detail but keeps the snapshot", () => {
		insertSeq(store, [makeReport({ scoredAt: "2026-01-01T00:00:00.000Z" })]);

		const report = buildHistory(store, { repo: "warren", since: "2026-12-01T00:00:00.000Z" });
		expect(report.fleet.map((e) => e.repo)).toEqual(["warren"]);
		expect(report.fleet[0]?.runs).toBe(0);
		expect(report.repos).toEqual([]);
	});
});
