import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditFixture } from "../report/audit-fixtures.ts";
import { renderAuditJson } from "../report/audit-json.ts";
import { ReportArtifactError } from "./load.ts";
import { runComparison } from "./run.ts";

/**
 * The artifact-comparison service (SPEC §9, §12, trellis-9a88): load two saved
 * report artifacts, compare them purely, and evaluate a supplied
 * configuration's policy. Real artifacts produced through the deterministic
 * core — never hand-shaped JSON.
 */

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "trellis-compare-run-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** Audit a render fixture and save its JSON artifact under `dir`. */
async function saveArtifact(kind: "clean" | "sloppy", name: string): Promise<string> {
	const fixture = await auditFixture(kind);
	try {
		const path = join(dir, name);
		await writeFile(path, renderAuditJson(fixture.report));
		return path;
	} finally {
		await fixture.cleanup();
	}
}

describe("runComparison", () => {
	test("compares two artifacts without an audit and gates nothing without a config", async () => {
		const baseline = await saveArtifact("clean", "a.json");
		const current = await saveArtifact("sloppy", "b.json");
		const result = await runComparison(baseline, current);
		expect(result.comparison.compatibility.comparable).toBe(true);
		expect(result.comparison.score?.delta).toBeGreaterThan(0);
		expect(result.comparison.findings?.new.length).toBeGreaterThan(0);
		expect(result.policy).toBeNull();
		// The artifacts round-trip onto the result for the renderers.
		expect(result.baseline.score.index).toBe(0);
		expect(result.current.score.index).toBeGreaterThan(0);
	});

	test("a supplied config gates the comparison (declarative policy, SPEC §9)", async () => {
		const baseline = await saveArtifact("clean", "a.json");
		const current = await saveArtifact("sloppy", "b.json");
		const configPath = join(dir, "trellis.yaml");
		await writeFile(configPath, "policy:\n  regression: {}\n  failOnNew:\n    - import-cycle\n");
		const result = await runComparison(baseline, current, { configPath });
		expect(result.policy?.failed).toBe(true);
		const kinds = result.policy?.results.filter((r) => r.status === "fail").map((r) => r.policy);
		expect(kinds).toContain("score-regression");
		expect(kinds).toContain("new-findings");
	});

	test("a passing policy leaves the comparison clean", async () => {
		const baseline = await saveArtifact("sloppy", "a.json");
		const current = await saveArtifact("sloppy", "b.json");
		const configPath = join(dir, "trellis.yaml");
		await writeFile(configPath, "policy:\n  maxIndex: 100\n");
		const result = await runComparison(baseline, current, { configPath });
		expect(result.policy?.failed).toBe(false);
	});

	test("an incompatible pair is reported explicitly, never silently compared", async () => {
		const baseline = await saveArtifact("clean", "a.json");
		const current = await saveArtifact("sloppy", "b.json");
		// Tamper the scoring version: the two indices are no longer on one scale.
		const { readFile } = await import("node:fs/promises");
		const tampered = JSON.parse(await readFile(current, "utf8")) as { scoringVersion: string };
		tampered.scoringVersion = "0.0.0-tampered";
		await writeFile(current, JSON.stringify(tampered, null, 2));
		const result = await runComparison(baseline, current);
		expect(result.comparison.compatibility.comparable).toBe(false);
		expect(result.comparison.compatibility.issues.map((i) => i.code)).toContain("scoring-version");
		expect(result.comparison.score).toBeUndefined();
	});

	test("a pre-provider artifact compares explicitly with a current one (old-new pair)", async () => {
		const baseline = await saveArtifact("clean", "a.json");
		// Downgrade the baseline to a pre-provider (schema 1.0.0) artifact: strip
		// the additive evidence area — exactly the shape older trellis emitted.
		const { readFile } = await import("node:fs/promises");
		const legacy = JSON.parse(await readFile(baseline, "utf8")) as Record<string, unknown>;
		delete legacy.evidence;
		legacy.schemaVersion = "1.0.0";
		await writeFile(baseline, JSON.stringify(legacy, null, 2));
		const current = await saveArtifact("sloppy", "b.json");
		const result = await runComparison(baseline, current);
		// The scored basis compares explicitly — with the span named, never silent.
		expect(result.comparison.compatibility.comparable).toBe(true);
		expect(result.comparison.compatibility.caveats.map((caveat) => caveat.code)).toContain(
			"schema-span",
		);
		expect(result.comparison.score?.delta).toBeGreaterThan(0);
		// The pre-provider side's provider evidence reads as unrequested — never a regression.
		const carried = result.comparison.evidence.providers;
		expect(carried.length).toBeGreaterThan(0);
		for (const provider of carried) {
			expect(provider.status).toBe("absent-on-baseline");
			expect(provider.reasons[0]?.message).toContain("predates the provider-evidence area");
		}
	});

	test("an unreadable artifact is an operational error", async () => {
		const current = await saveArtifact("sloppy", "b.json");
		await expect(runComparison(join(dir, "absent.json"), current)).rejects.toThrow(
			ReportArtifactError,
		);
	});

	test("an invalid artifact is an operational error", async () => {
		const bad = join(dir, "bad.json");
		await writeFile(bad, JSON.stringify({ not: "a report" }));
		const current = await saveArtifact("sloppy", "b.json");
		await expect(runComparison(bad, current)).rejects.toThrow(/invalid audit report/);
	});

	test("config and configPath are mutually exclusive", async () => {
		const baseline = await saveArtifact("clean", "a.json");
		const current = await saveArtifact("sloppy", "b.json");
		await expect(
			runComparison(baseline, current, {
				config: {
					source: { exclude: [], classify: {} },
					policy: { budgets: {}, failOnNew: [], requireEvidence: [] },
				},
				configPath: join(dir, "trellis.yaml"),
			}),
		).rejects.toThrow(/at most one of config/);
	});
});
