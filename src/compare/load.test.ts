import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditReport } from "../contract/index.ts";
import { auditFixture, type FixtureReport } from "../report/audit-fixtures.ts";
import { renderAuditJson } from "../report/audit-json.ts";
import { compareReports } from "./compare.ts";
import { loadReportArtifact, ReportArtifactError } from "./load.ts";

let dir: string;
const fixtures = new Map<string, FixtureReport>();

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "trellis-compare-load-"));
	for (const kind of ["clean", "sloppy"] as const) {
		fixtures.set(kind, await auditFixture(kind));
	}
});

afterAll(async () => {
	await Promise.all([...fixtures.values()].map((fixture) => fixture.cleanup()));
	await rm(dir, { recursive: true, force: true });
});

function report(kind: string): AuditReport {
	const fixture = fixtures.get(kind);
	if (fixture === undefined) throw new Error(`fixture ${kind} not built`);
	return fixture.report;
}

/** Persist a report as a JSON artifact exactly as the renderer emits it. */
async function save(name: string, contents: string): Promise<string> {
	const path = join(dir, name);
	await writeFile(path, contents);
	return path;
}

describe("loadReportArtifact", () => {
	test("round-trips a rendered report through disk with no Git or SQLite", async () => {
		const path = await save("sloppy.json", renderAuditJson(report("sloppy")));
		const loaded = await loadReportArtifact(path);
		expect(loaded).toEqual(report("sloppy"));
	});

	test("two saved artifacts compare directly", async () => {
		const baselinePath = await save("baseline.json", renderAuditJson(report("clean")));
		const currentPath = await save("current.json", renderAuditJson(report("sloppy")));
		const comparison = compareReports(
			await loadReportArtifact(baselinePath),
			await loadReportArtifact(currentPath),
		);
		expect(comparison.compatibility.comparable).toBe(true);
		expect(comparison.score?.delta).toBeGreaterThan(0);
		const newKinds = comparison.findings?.new.map((finding) => finding.kind) ?? [];
		expect(newKinds).toContain("import-cycle");
		expect(newKinds).toContain("complexity.hotspot");
	});

	test("throws an operational error for an unreadable path", async () => {
		await expect(loadReportArtifact(join(dir, "missing.json"))).rejects.toBeInstanceOf(
			ReportArtifactError,
		);
	});

	test("throws an operational error for a non-JSON document", async () => {
		const path = await save("not-json.json", "this is { not json");
		await expect(loadReportArtifact(path)).rejects.toBeInstanceOf(ReportArtifactError);
	});

	test("throws an operational error naming the schema violations", async () => {
		const invalid = { ...report("clean"), schemaVersion: undefined };
		const path = await save("invalid.json", JSON.stringify(invalid));
		const error = await loadReportArtifact(path).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ReportArtifactError);
		expect((error as ReportArtifactError).message).toContain("invalid audit report");
		expect((error as ReportArtifactError).path).toBe(path);
	});

	test("rejects a report that violates the cross-field honesty invariants", async () => {
		// The clean fixture's metrics are all complete, so an "incomplete" claim
		// violates the §6.4 completeness rollup.
		const dishonest = { ...report("clean"), completeness: "incomplete" };
		const path = await save("dishonest.json", JSON.stringify(dishonest));
		await expect(loadReportArtifact(path)).rejects.toBeInstanceOf(ReportArtifactError);
	});
});
