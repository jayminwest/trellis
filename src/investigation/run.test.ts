import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../store/index.ts";
import type { AreaId } from "./areas.ts";
import type { DocumentationFindings } from "./findings.ts";
import type { InvestigateFn, InvestigationContext, InvestigationEvent } from "./run.ts";
import { runInvestigation } from "./run.ts";

/**
 * Cache hit/miss/no-cache flows (SPEC §7.3/§9.5) exercised against a real temp
 * SQLite store and a stubbed provider — no `pi`, no network. The probe is stubbed
 * to "available" so the resolver reaches the (stubbed) investigate on a miss;
 * separate tests force the probe to fail to cover the Pi-unavailable degradation.
 */

const DOC_FACTS: DocumentationFindings = {
	readme: { present: true, atRoot: true, hasSetup: true, hasUsage: true },
	buildCommandDocumented: true,
	docGenerationMechanisms: ["typedoc"],
	runbooks: ["RUNBOOK.md"],
	singleCommandSetupDocumented: true,
	keyDocs: [{ path: "README.md", daysSinceModified: 5 }],
	architectureDocs: ["docs/architecture.mmd"],
};

const CTX: InvestigationContext = {
	repoPath: "/tmp/whatever",
	repo: "fixture",
	commitSha: "abc123",
	createdAt: "2026-06-06T12:00:00.000Z",
};

const okProbe = async () => ({ ok: true as const, version: "0.74.0" });

/** A stubbed investigate that returns the documentation facts and counts its calls. */
function countingInvestigate(): { fn: InvestigateFn; calls: () => AreaId[] } {
	const seen: AreaId[] = [];
	const fn = (async (_repo, area) => {
		seen.push(area);
		return { ok: true as const, area, findings: DOC_FACTS };
	}) as InvestigateFn;
	return { fn, calls: () => seen };
}

describe("runInvestigation caching", () => {
	let dbDir: string;
	let store: Store;

	beforeEach(() => {
		dbDir = mkdtempSync(join(tmpdir(), "trellis-run-db-"));
		store = openStore(join(dbDir, "trellis.db"));
	});

	afterEach(() => {
		store.close();
		rmSync(dbDir, { recursive: true, force: true });
	});

	test("a miss investigates, validates, and writes the findings to the cache", async () => {
		const { fn, calls } = countingInvestigate();
		const out = await runInvestigation(["documentation"], CTX, {
			cache: store,
			investigate: fn,
			probe: okProbe,
		});

		expect(calls()).toEqual(["documentation"]);
		const res = out.get("documentation");
		expect(res?.ok).toBe(true);
		if (res?.ok) expect(res.findings).toEqual(DOC_FACTS);

		const cached = store.getCache("fixture", "abc123", "documentation");
		expect(cached).not.toBeNull();
		expect(JSON.parse(cached?.findingsJson ?? "null")).toEqual(DOC_FACTS);
		expect(cached?.createdAt).toBe("2026-06-06T12:00:00.000Z");
	});

	test("a hit reuses cached findings without invoking the provider", async () => {
		const first = countingInvestigate();
		await runInvestigation(["documentation"], CTX, {
			cache: store,
			investigate: first.fn,
			probe: okProbe,
		});

		// Second resolve at the same (repo, commit, area): the stub must not run.
		const second = countingInvestigate();
		const out = await runInvestigation(["documentation"], CTX, {
			cache: store,
			investigate: second.fn,
			probe: okProbe,
		});

		expect(second.calls()).toEqual([]);
		const res = out.get("documentation");
		expect(res?.ok).toBe(true);
		if (res?.ok) expect(res.findings).toEqual(DOC_FACTS);
	});

	test("--no-cache forces re-investigation even when a cache row exists", async () => {
		await runInvestigation(["documentation"], CTX, {
			cache: store,
			investigate: countingInvestigate().fn,
			probe: okProbe,
		});

		const forced = countingInvestigate();
		await runInvestigation(["documentation"], CTX, {
			cache: store,
			noCache: true,
			investigate: forced.fn,
			probe: okProbe,
		});

		expect(forced.calls()).toEqual(["documentation"]);
	});

	test("each referenced area is investigated at most once per run", async () => {
		const { fn, calls } = countingInvestigate();
		const areas: AreaId[] = ["documentation", "documentation", "agent-config"];
		await runInvestigation(areas, CTX, { cache: store, investigate: fn, probe: okProbe });
		expect(calls().sort()).toEqual(["agent-config", "documentation"]);
	});

	test("a different commit sha is a cache miss (key includes commit_sha)", async () => {
		await runInvestigation(["documentation"], CTX, {
			cache: store,
			investigate: countingInvestigate().fn,
			probe: okProbe,
		});

		const dirtyRun = countingInvestigate();
		await runInvestigation(
			["documentation"],
			{ ...CTX, commitSha: "abc123-dirty" },
			{
				cache: store,
				investigate: dirtyRun.fn,
				probe: okProbe,
			},
		);

		expect(dirtyRun.calls()).toEqual(["documentation"]);
	});

	test("a corrupt cache row is ignored and the area is re-investigated", async () => {
		store.putCache("fixture", "abc123", "documentation", "{not valid json", "t0");
		const { fn, calls } = countingInvestigate();
		const out = await runInvestigation(["documentation"], CTX, {
			cache: store,
			investigate: fn,
			probe: okProbe,
		});
		expect(calls()).toEqual(["documentation"]);
		expect(out.get("documentation")?.ok).toBe(true);
	});
});

describe("runInvestigation Pi-unavailable degradation", () => {
	test("a failed probe degrades every miss to a no-detector resolution, never spawning Pi", async () => {
		const { fn, calls } = countingInvestigate();
		const out = await runInvestigation(["documentation", "agent-config"], CTX, {
			investigate: fn,
			probe: async () => ({ ok: false as const, reason: "pi not installed", hint: "install pi" }),
		});

		expect(calls()).toEqual([]); // probe gates the per-area runs
		for (const area of ["documentation", "agent-config"] as const) {
			const res = out.get(area);
			expect(res?.ok).toBe(false);
			if (res && !res.ok) {
				expect(res.reason).toContain("pi not installed");
				expect(res.reason).toContain("install pi");
			}
		}
	});

	test("a fully-cached run resolves without probing Pi", async () => {
		const dbDir = mkdtempSync(join(tmpdir(), "trellis-run-db-"));
		const store = openStore(join(dbDir, "trellis.db"));
		try {
			store.putCache("fixture", "abc123", "documentation", JSON.stringify(DOC_FACTS), "t0");
			let probed = false;
			const out = await runInvestigation(["documentation"], CTX, {
				cache: store,
				probe: async () => {
					probed = true;
					return { ok: false as const, reason: "should never run", hint: "" };
				},
			});
			expect(probed).toBe(false);
			expect(out.get("documentation")?.ok).toBe(true);
		} finally {
			store.close();
			rmSync(dbDir, { recursive: true, force: true });
		}
	});

	test("a per-area investigation failure surfaces as a no-detector resolution", async () => {
		const failing = (async (_repo, area) => ({
			ok: false as const,
			area,
			reason: "no submit_findings call after 2 retries",
		})) as InvestigateFn;
		const out = await runInvestigation(["documentation"], CTX, {
			investigate: failing,
			probe: okProbe,
		});
		const res = out.get("documentation");
		expect(res?.ok).toBe(false);
		if (res && !res.ok) expect(res.reason).toContain("submit_findings");
	});
});

describe("runInvestigation progress events", () => {
	test("a miss emits area-start, probe, and area-end (no cache-hit)", async () => {
		const events: InvestigationEvent[] = [];
		await runInvestigation(["documentation"], CTX, {
			investigate: countingInvestigate().fn,
			probe: okProbe,
			onProgress: (event) => events.push(event),
		});
		expect(events).toContainEqual({
			type: "area-start",
			area: "documentation",
			index: 0,
			total: 1,
		});
		expect(events).toContainEqual({ type: "probe", ok: true, detail: "0.74.0" });
		expect(events).toContainEqual({ type: "area-end", area: "documentation", ok: true });
		expect(events.some((e) => e.type === "cache-hit")).toBe(false);
	});

	test("a cache hit emits cache-hit + area-end and never probes", async () => {
		const dbDir = mkdtempSync(join(tmpdir(), "trellis-run-db-"));
		const store = openStore(join(dbDir, "trellis.db"));
		try {
			store.putCache("fixture", "abc123", "documentation", JSON.stringify(DOC_FACTS), "t0");
			const events: InvestigationEvent[] = [];
			await runInvestigation(["documentation"], CTX, {
				cache: store,
				probe: async () => ({ ok: false as const, reason: "must not run", hint: "" }),
				onProgress: (event) => events.push(event),
			});
			expect(events).toContainEqual({ type: "cache-hit", area: "documentation" });
			expect(events.some((e) => e.type === "probe")).toBe(false);
		} finally {
			store.close();
			rmSync(dbDir, { recursive: true, force: true });
		}
	});

	test("a failed probe emits probe(ok:false) and a reasoned area-end per miss", async () => {
		const events: InvestigationEvent[] = [];
		await runInvestigation(["documentation"], CTX, {
			investigate: countingInvestigate().fn,
			probe: async () => ({ ok: false as const, reason: "pi missing", hint: "install pi" }),
			onProgress: (event) => events.push(event),
		});
		expect(events).toContainEqual({ type: "probe", ok: false, detail: "pi missing" });
		const end = events.find((e) => e.type === "area-end");
		expect(end?.type === "area-end" && end.ok).toBe(false);
	});

	test("session events from the provider are lifted and tagged with their area", async () => {
		const sessioned = (async (_repo, area, opts) => {
			opts?.onSession?.({ type: "message" });
			opts?.onSession?.({ type: "agent-end" });
			return { ok: true as const, area, findings: DOC_FACTS };
		}) as InvestigateFn;
		const events: InvestigationEvent[] = [];
		await runInvestigation(["documentation"], CTX, {
			investigate: sessioned,
			probe: okProbe,
			onProgress: (event) => events.push(event),
		});
		expect(events).toContainEqual({
			type: "session",
			area: "documentation",
			event: { type: "message" },
		});
	});
});
