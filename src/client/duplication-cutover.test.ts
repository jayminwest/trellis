import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReportArtifact } from "../compare/load.ts";
import { type AuditReport, auditReportSchema, measurementPayload } from "../contract/index.ts";
import { lineOverlapSchema } from "../contract/line-overlap.ts";
import { repeatedSource } from "../metrics/tests/duplication-fixtures.ts";
import { renderAuditMarkdown } from "../report/audit-markdown.ts";
import { renderAuditTerminal } from "../report/audit-terminal.ts";
import * as client from "./index.ts";

const MAIN = join(import.meta.dir, "..", "cli", "main.ts");
let root: string;
let artifacts: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "trellis-native-cutover-"));
	artifacts = await mkdtemp(join(tmpdir(), "trellis-cutover-artifacts-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
	await rm(artifacts, { recursive: true, force: true });
});

async function cli(args: string[]) {
	const child = Bun.spawn([process.execPath, MAIN, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			PATH: "",
			TRELLIS_DB: join(artifacts, "unrequested.db"),
			TRELLIS_LOG_LEVEL: "silent",
		},
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, code };
}

async function copies(count: number) {
	for (let i = 0; i < count; i++) await writeFile(join(root, `f${i}.ts`), repeatedSource(`fn${i}`));
}

function previousIdentity(report: AuditReport) {
	const old = structuredClone(report);
	if (!("evidence" in old)) throw new Error("Expected evidence-bearing report");
	old.analyzerVersion = "0.2.2";
	for (const analysis of old.evidence.analyses) {
		if (analysis.provider.kind !== "native") continue;
		analysis.provider.toolVersion = "0.2.2";
		analysis.provider.adapterVersion = "0.2.2";
		if (analysis.provider.id !== "trellis.duplication") continue;
		analysis.provider.options = {};
		if (analysis.analysis !== undefined)
			analysis.analysis.options = { "max-tokens": 2_000_000, "max-match-work": 100_000_000 };
	}
	return old;
}

describe("native duplication cutover", () => {
	test("completes forty copies identically through CLI and SDK with no target writes", async () => {
		await copies(40);
		await writeFile(
			join(root, "package.json"),
			JSON.stringify({ scripts: { prepare: "touch must-not-execute" } }),
		);
		const names = (await readdir(root)).sort();
		const contents = await Promise.all(names.map((name) => readFile(join(root, name), "utf8")));
		const sdk = await client.audit(root);
		const ran = await cli(["audit", root, "--json", "--quiet"]);
		expect(ran.code).toBe(0);
		const report = auditReportSchema.parse(JSON.parse(ran.stdout));
		expect(measurementPayload(report)).toEqual(measurementPayload(sdk.report));
		expect(report.analyzerVersion).toBe("0.2.3");
		expect(report.schemaVersion).toBe("1.2.0");
		expect(report.scoringVersion).toBe("0.2.0-provisional");
		expect(report.metrics["duplication.groups.production"]).toMatchObject({
			state: "complete",
			value: 1,
		});
		expect(report.metrics["duplication.duplicated-lines.production"]).toMatchObject({
			state: "complete",
			value: 1080,
		});
		expect(report.metrics["duplication.density.production"]).toMatchObject({
			state: "complete",
			value: 1,
		});
		expect(report.score.partial).toBe(false);
		expect(
			report.findings.find((finding) => finding.kind === "duplication.clone-group")?.facts
				?.memberCount,
		).toBe(40);
		expect(report.metrics["duplication.groups.test"]?.value).toBe(0);
		expect(
			report.findings.find((finding) => finding.kind === "duplication.clone-group")?.facts
				?.lineOverlap,
		).toEqual({ version: 1, overlaps: false, memberIndexes: [], spans: [] });
		expect((await readdir(root)).sort()).toEqual(names);
		expect(await Promise.all(names.map((name) => readFile(join(root, name), "utf8")))).toEqual(
			contents,
		);
		for (const name of ["node_modules", ".git", "must-not-execute"])
			expect(existsSync(join(root, name))).toBe(false);
		expect(existsSync(join(artifacts, "unrequested.db"))).toBe(false);
	});

	test("carries overlap context through CLI, SDK and historical artifacts without score churn", async () => {
		const source = Array.from({ length: 40 }, (_, i) => `const value${i} = ${i} + ${i + 1};`).join(
			"\n",
		);
		await writeFile(join(root, "repeat.ts"), source);
		await writeFile(join(root, "repeat.test.ts"), source);
		const current = (await client.audit(root)).report;
		const ran = await cli(["audit", root, "--json", "--quiet"]);
		expect(ran.code).toBe(0);
		expect(measurementPayload(auditReportSchema.parse(JSON.parse(ran.stdout)))).toEqual(
			measurementPayload(current),
		);
		const clones = current.findings.filter((finding) => finding.kind === "duplication.clone-group");
		expect(new Set(clones.map((finding) => finding.facts?.sourceSet))).toEqual(
			new Set(["production", "test"]),
		);
		for (const clone of clones) {
			const overlap = lineOverlapSchema.parse(clone.facts?.lineOverlap);
			expect(overlap.overlaps).toBe(true);
			expect(overlap.memberIndexes.length).toBeGreaterThanOrEqual(2);
			expect(new Set(overlap.spans.map((span) => span.path))).toEqual(new Set([clone.path]));
		}
		for (const render of [renderAuditTerminal, renderAuditMarkdown]) {
			expect(render(current)).toContain("review the repeated structure");
		}
		const historical = structuredClone(current);
		for (const finding of historical.findings) {
			if (finding.facts) delete finding.facts.lineOverlap;
		}
		const before = join(artifacts, "before-overlap.json");
		const after = join(artifacts, "with-overlap.json");
		await writeFile(before, JSON.stringify(historical));
		await writeFile(after, JSON.stringify(current));
		expect(await loadReportArtifact(before)).toEqual(historical);
		expect(historical.metrics).toEqual(current.metrics);
		expect(historical.score).toEqual(current.score);
		const compared = await client.compare(before, after);
		expect(compared.comparison.compatibility.comparable).toBe(true);
		expect(compared.comparison.score?.delta).toBe(0);
		expect(compared.comparison.findings?.new).toEqual([]);
		expect(compared.comparison.findings?.resolved).toEqual([]);
		for (const schemaVersion of ["1.0.0", "1.1.0", "1.2.0"] as const) {
			const artifact: Record<string, unknown> = { ...historical, schemaVersion };
			if (schemaVersion === "1.0.0") delete artifact.evidence;
			await writeFile(before, JSON.stringify(artifact));
			const loaded = await loadReportArtifact(before);
			expect(loaded.schemaVersion).toBe(schemaVersion);
			expect(renderAuditTerminal(loaded)).toContain("line overlap: unknown");
			expect(renderAuditMarkdown(loaded)).toContain("line overlap: unknown");
		}
		await writeFile(join(root, "broken.ts"), "export function broken( {");
		const partial = (await client.audit(root)).report;
		expect(partial.metrics["duplication.groups.production"]?.state).toBe("incomplete");
		expect(
			partial.findings.filter((finding) => finding.kind === "duplication.clone-group"),
		).toEqual(clones);
	});

	test("keeps forced exhaustion incomplete and unmeasured through the SDK", async () => {
		await copies(2);
		for (const duplicationBudget of [
			{ maxTokens: 5, maxMatchWork: 100_000_000 },
			{ maxTokens: 2_000_000, maxMatchWork: 5 },
		]) {
			const result = await client.audit(root, { duplicationBudget });
			expect(result.report.score.partial).toBe(true);
			for (const name of ["groups", "density", "duplicated-lines"]) {
				const metric = result.report.metrics[`duplication.${name}.production`];
				expect(metric?.state).toBe("incomplete");
				expect(metric?.value).toBeUndefined();
				expect(metric?.reason).toContain("input");
			}
			expect(
				result.report.findings.filter((finding) => finding.kind === "duplication.clone-group"),
			).toEqual([]);
		}
	});

	test("reads prior artifacts while refusing changed analyzer and resource semantics", async () => {
		await copies(2);
		const current = (await client.audit(root)).report;
		const old = previousIdentity(current);
		const baseline = join(artifacts, "old.json");
		const after = join(artifacts, "new.json");
		const configPath = join(artifacts, "policy.yaml");
		await writeFile(configPath, "policy:\n  failOnNew: [complexity.hotspot]\n");
		await writeFile(baseline, JSON.stringify(old));
		await writeFile(after, JSON.stringify(current));
		expect(await loadReportArtifact(baseline)).toEqual(old);
		const compared = await client.compare(baseline, after, { configPath });
		expect(compared.policy?.failed).toBe(true);
		expect(compared.comparison.compatibility.issues.map((issue) => issue.code)).toContain(
			"analyzer-version",
		);
		expect(compared.comparison.findings).toBeUndefined();
		const ran = await cli(["compare", baseline, after, "--config", configPath, "--json"]);
		expect(ran.code).toBe(2);
		expect(JSON.parse(ran.stdout)).toEqual(compared.comparison);
		const disguised = previousIdentity(current);
		disguised.analyzerVersion = current.analyzerVersion;
		for (const analysis of disguised.evidence.analyses) {
			analysis.provider.toolVersion = current.analyzerVersion;
			analysis.provider.adapterVersion = current.analyzerVersion;
		}
		await writeFile(baseline, JSON.stringify(disguised));
		const guarded = await client.compare(baseline, after, { configPath });
		expect(guarded.comparison.compatibility.issues.map((issue) => issue.code)).toContain(
			"scored-measurement",
		);
		expect(guarded.policy?.failed).toBe(true);
	});
});
