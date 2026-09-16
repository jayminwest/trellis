import { describe, expect, test } from "bun:test";
import type { AuditOptions, Report } from "../report/index.ts";
import type { DriftReport } from "../standards/index.ts";
import { openStore, type Store } from "../store/index.ts";
import { type FleetRunDeps, runFleet } from "./orchestrate.ts";
import type { Fleet, ResolvedTarget } from "./targets.ts";

/** A fixed instant so every run's `scoredAt` is deterministic. */
const NOW = new Date("2026-06-06T00:00:00.000Z");

/** Build a resolved target (`absPath` defaults to `/abs/<id>`). */
function target(id: string, spec: Partial<ResolvedTarget["spec"]> = {}): ResolvedTarget {
	return { spec: { id, path: id, ...spec }, absPath: `/abs/${id}` };
}

/** Build a one-target+ fleet with optional defaults. */
function fleet(targets: ResolvedTarget[], defaults: Fleet["defaults"] = {}): Fleet {
	return { defaults, targets, baseDir: "/base" };
}

/** A minimal valid {@link Report}; `repo` is overwritten by the audit stub from `repoId`. */
function report(repo: string, over: Partial<Report> = {}): Report {
	return {
		repo,
		rubricVersion: "1.0.0",
		scoredAt: NOW.toISOString(),
		commit: "abc123",
		level: 3,
		passRate: 0.5,
		coverage: 0.8,
		apps: { ".": { description: "root" } },
		criteria: {},
		...over,
	};
}

/** An audit stub that honors `repoId` (so the store keys correctly) and applies `over`. */
function stubAudit(
	over: (opts: AuditOptions) => Partial<Report> = () => ({}),
): (path: string, opts: AuditOptions) => Promise<Report> {
	return async (_path, opts) => report(opts.repoId ?? "unknown", over(opts));
}

/** A drift report with the given failing-state counts (other states zeroed). */
function drift(driftCount: number, missing: number): DriftReport {
	return {
		repo: "x",
		canonicalVersion: "1.0.0",
		files: [],
		summary: { match: 0, "allowed-delta": 0, drift: driftCount, missing, extra: 0 },
	};
}

/** Common deps: in-memory store, pinned clock, all paths present. */
function deps(store: Store, over: Partial<FleetRunDeps> = {}): FleetRunDeps {
	return { store, now: NOW, pathExists: () => true, audit: stubAudit(), ...over };
}

describe("runFleet", () => {
	test("audits every target and writes one run row per target", async () => {
		const store = openStore(":memory:");
		try {
			const report = await runFleet(fleet([target("a"), target("b")]), deps(store));
			expect(report.entries.map((e) => e.id)).toEqual(["a", "b"]);
			expect(report.entries.every((e) => e.ok)).toBe(true);
			expect(report.summary).toEqual({ ok: 2, error: 0 });
			expect(report.scoredAt).toBe(NOW.toISOString());
			// Two runs persisted — one per target, keyed by the targets.yaml id.
			expect(store.runsSince("a", "1970-01-01T00:00:00.000Z")).toHaveLength(1);
			expect(store.runsSince("b", "1970-01-01T00:00:00.000Z")).toHaveLength(1);
		} finally {
			store.close();
		}
	});

	test("isolates a per-target audit failure without aborting the fleet", async () => {
		const store = openStore(":memory:");
		try {
			const audit = stubAudit((opts) => {
				if (opts.repoId === "bad") throw new Error("canonical version 9.9.9 is not bundled");
				return {};
			});
			const report = await runFleet(
				fleet([target("ok1"), target("bad"), target("ok2")]),
				deps(store, { audit }),
			);
			expect(report.summary).toEqual({ ok: 2, error: 1 });
			const bad = report.entries.find((e) => e.id === "bad");
			expect(bad?.ok).toBe(false);
			expect(bad?.ok === false && bad.error).toMatch(/not bundled/);
			// The surviving targets still scored and persisted.
			expect(store.latestRun("ok1")).not.toBeNull();
			expect(store.latestRun("ok2")).not.toBeNull();
			expect(store.latestRun("bad")).toBeNull();
		} finally {
			store.close();
		}
	});

	test("reports a missing target path as a per-target error", async () => {
		const store = openStore(":memory:");
		try {
			const pathExists = (p: string) => p !== "/abs/gone";
			const report = await runFleet(
				fleet([target("here"), target("gone")]),
				deps(store, { pathExists }),
			);
			const gone = report.entries.find((e) => e.id === "gone");
			expect(gone?.ok).toBe(false);
			expect(gone?.ok === false && gone.error).toMatch(/path not found/);
			expect(store.latestRun("here")).not.toBeNull();
			expect(store.latestRun("gone")).toBeNull();
		} finally {
			store.close();
		}
	});

	test("computes a level delta against the repo's previous run", async () => {
		const store = openStore(":memory:");
		try {
			const first = await runFleet(
				fleet([target("a")]),
				deps(store, { audit: stubAudit(() => ({ level: 2 })) }),
			);
			expect(first.entries[0]?.ok && first.entries[0].previousLevel).toBeNull();
			expect(first.entries[0]?.ok && first.entries[0].levelDelta).toBeNull();

			const second = await runFleet(
				fleet([target("a")]),
				deps(store, { audit: stubAudit(() => ({ level: 4 })) }),
			);
			const entry = second.entries[0];
			expect(entry?.ok && entry.previousLevel).toBe(2);
			expect(entry?.ok && entry.levelDelta).toBe(2);
		} finally {
			store.close();
		}
	});

	test("surfaces canonical-drift summary counts on the entry", async () => {
		const store = openStore(":memory:");
		try {
			const audit = stubAudit(() => ({ drift: drift(2, 1) }));
			const report = await runFleet(fleet([target("a")]), deps(store, { audit }));
			const entry = report.entries[0];
			expect(entry?.ok && entry.drift).toEqual({
				match: 0,
				"allowed-delta": 0,
				drift: 2,
				missing: 1,
				extra: 0,
			});
		} finally {
			store.close();
		}
	});

	test("passes the resolved per-target options and shared clock into the audit", async () => {
		const store = openStore(":memory:");
		const seen: AuditOptions[] = [];
		try {
			const audit = (path: string, opts: AuditOptions) => {
				seen.push(opts);
				return stubAudit()(path, opts);
			};
			await runFleet(
				fleet([target("warren", { skip: ["dast_scanning"] })], {
					canonicalVersion: "1.0.0",
				}),
				deps(store, { audit }),
			);
			const opts = seen[0];
			expect(opts?.repoId).toBe("warren");
			expect(opts?.skip).toEqual(["dast_scanning"]);
			expect(opts?.canonical?.canonicalVersion).toBe("1.0.0");
			expect(opts?.now).toBe(NOW);
			// No investigation wiring remains on the audit path (SPEC §14 stage 2).
			expect(opts && "investigation" in opts).toBe(false);
		} finally {
			store.close();
		}
	});
});
