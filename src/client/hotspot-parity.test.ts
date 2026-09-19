import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReportArtifact } from "../compare/load.ts";
import {
	type AuditReport,
	auditReportSchema,
	type Finding,
	measurementPayload,
} from "../contract/index.ts";
import { repeatedSource } from "../metrics/tests/duplication-fixtures.ts";
import { openStore, repoIdentity, storedAuditReport } from "../store/index.ts";
import * as client from "./index.ts";

const MAIN = join(import.meta.dir, "..", "cli", "main.ts");
const BODY = Array.from({ length: 11 }, (_, i) => `if (n === ${i}) return ${i};`).join("\n");
const named = (name: string) => `function ${name}(n: number) {\n${BODY}\n}\n`;
const method = (name: string) => `class ${name} { run(n: number) {\n${BODY}\n} }\n`;
const POLICY = "policy:\n  failOnNew: [complexity.hotspot]\n";
let directory: string;
let root: string;
let configPath: string;
let baselinePath: string;
let currentPath: string;
let db: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "trellis-hotspot-surfaces-"));
	root = join(directory, "workspace");
	await mkdir(root);
	configPath = join(root, "trellis.yaml");
	await writeFile(configPath, POLICY);
	baselinePath = join(directory, "baseline.json");
	currentPath = join(directory, "current.json");
	db = join(directory, "history.db");
});
afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

/** Empty PATH proves these source-only controls need no Git or project tools. */
async function cli(args: string[]) {
	const child = Bun.spawn([process.execPath, MAIN, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, PATH: "", TRELLIS_DB: db, TRELLIS_LOG_LEVEL: "silent" },
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, code };
}

async function seed(source: string) {
	await writeFile(join(root, "a.ts"), source);
	return client.audit(root);
}

function persist(path: string, report: AuditReport) {
	const store = openStore(path);
	try {
		store.insertAuditRun(report);
	} finally {
		store.close();
	}
}

async function assertFleetParity(
	baseline: AuditReport,
	sdk: client.WorkspaceAuditResult,
	fails: boolean,
) {
	// Each fleet resolves the same baseline from its own explicitly requested history DB.
	const targets = join(directory, "targets.yaml");
	await writeFile(targets, `targets:\n  - id: fixture\n    path: ${JSON.stringify(root)}\n`);
	const sdkDb = join(directory, "fleet-sdk.db");
	persist(sdkDb, baseline);
	persist(db, baseline);
	const fleet = await client.fleet(targets, { history: true, db: sdkDb });
	const entry = fleet.entries[0];
	if (entry?.ok !== true) throw new Error("fleet target failed");
	expect(entry.policy).toEqual(sdk.policy);
	expect(measurementPayload(entry.report)).toEqual(measurementPayload(sdk.report));
	expect(client.assessFleet(fleet).failed).toBe(fails);
	const fleetCli = await cli(["fleet", "--targets", targets, "--history", "--db", db, "--json"]);
	expect(fleetCli.code).toBe(fails ? 2 : 0);
	const fleetJson: client.FleetReport = JSON.parse(fleetCli.stdout);
	const cliEntry = fleetJson.entries[0];
	if (cliEntry?.ok !== true) throw new Error("CLI fleet target failed");
	expect(cliEntry.policy).toEqual(sdk.policy);
	expect(measurementPayload(cliEntry.report)).toEqual(measurementPayload(sdk.report));
}

async function prepareCopies(count: number): Promise<string[]> {
	const names: string[] = [];
	for (let i = 1; i < count; i++) {
		const name = `copy${i}.ts`;
		names.push(name);
		await writeFile(join(root, name), repeatedSource(`copy${i}`));
	}
	return names;
}

function assertCopies(report: AuditReport, count: number): void {
	if (count === 0) return;
	expect(report.metrics["duplication.groups.production"]).toMatchObject({
		state: "complete",
		value: 1,
	});
	expect(report.metrics["duplication.duplicated-lines.production"]?.value).toBe(1080);
	expect(report.findings.find((f) => f.kind === "duplication.clone-group")?.facts).toMatchObject({
		memberCount: count,
		tokenCount: 229,
	});
	expect(report.score.partial).toBe(false);
}

const REPETITIVE = repeatedSource("copy0");

const CONTROLS = [
	{
		name: "forty-copy corpus with stable hotspot identities",
		before: REPETITIVE,
		after: `// unchanged functions below\n${REPETITIVE}`,
		fails: false,
		counts: [0, 0, 40],
		copies: 40,
	},
	{
		name: "comment-only shift",
		before: named("alpha") + named("beta"),
		after: `// shift\n${named("alpha")}${named("beta")}`,
		fails: false,
		counts: [0, 0, 2],
		copies: 0,
	},
	{
		name: "added gamma",
		before: named("alpha") + named("beta"),
		after: named("alpha") + named("beta") + named("gamma"),
		fails: true,
		counts: [1, 0, 2],
		copies: 0,
	},
	{
		name: "replacement beta",
		before: named("alpha"),
		after: named("beta"),
		fails: true,
		counts: [1, 1, 0],
		copies: 0,
	},
	{
		name: "added B.run",
		before: method("A"),
		after: method("A") + method("B"),
		fails: true,
		counts: [1, 0, 1],
		copies: 0,
	},
] as const;

describe("scoped hotspot surface acceptance", () => {
	for (const control of CONTROLS) {
		test(`agrees on ${control.name} across saved comparison, CLI, SDK and fleet`, async () => {
			const extraFiles = await prepareCopies(control.copies);
			const baseline = await seed(control.before);
			await writeFile(baselinePath, JSON.stringify(baseline.report));
			await writeFile(join(root, "a.ts"), control.after);
			const sdk = await client.audit(root, { baselinePath });
			expect(sdk.policy.failed).toBe(control.fails);
			assertCopies(sdk.report, control.copies);

			await writeFile(currentPath, JSON.stringify(sdk.report));
			expect(await loadReportArtifact(baselinePath)).toEqual(baseline.report);
			expect(await loadReportArtifact(currentPath)).toEqual(sdk.report);
			const saved = await client.compare(baselinePath, currentPath, { configPath });
			expect(saved.policy).toEqual(sdk.policy);
			const changes = saved.comparison.findings;
			if (changes === undefined) throw new Error("missing comparison");
			const count = (findings: readonly { kind: string }[]) =>
				findings.filter((finding) => finding.kind === "complexity.hotspot").length;
			expect([
				count(changes.new),
				count(changes.resolved),
				count(changes.persistent.map((pair) => pair.current)),
			]).toEqual([...control.counts]);
			const code = control.fails ? 2 : 0;
			const audited = await cli(["audit", root, "--baseline", baselinePath, "--json", "--quiet"]);
			expect(audited.code).toBe(code);
			expect(measurementPayload(auditReportSchema.parse(JSON.parse(audited.stdout)))).toEqual(
				measurementPayload(sdk.report),
			);
			const compared = await cli([
				"compare",
				baselinePath,
				currentPath,
				"--config",
				configPath,
				"--json",
			]);
			expect(compared.code).toBe(code);
			expect(JSON.parse(compared.stdout)).toEqual(saved.comparison);
			if (control.fails) {
				const reason = sdk.policy.results
					.flatMap((result) => result.reasons)
					.find((reason) => reason.code === "new-finding");
				expect(reason).toBeDefined();
				expect(audited.stderr).toContain(reason?.message ?? "missing reason");
				expect(compared.stderr).toContain(reason?.message ?? "missing reason");
			} else {
				expect(sdk.report.metrics).toEqual(baseline.report.metrics);
				expect(sdk.report.score).toEqual(baseline.report.score);
			}
			// Stateless surfaces have not created a DB, installed dependencies or touched the source.
			expect(existsSync(db)).toBe(false);
			expect((await readdir(root)).sort()).toEqual(["a.ts", ...extraFiles, "trellis.yaml"].sort());
			expect(await readFile(join(root, "a.ts"), "utf8")).toBe(control.after);
			expect(await readFile(configPath, "utf8")).toBe(POLICY);

			await assertFleetParity(baseline.report, sdk, control.fails);
		}, 20_000);
	}

	test("preserves identified and ambiguous provenance through SQLite baseline resolution", async () => {
		await seed(`${named("alpha")}values.map((n) => {\n${BODY}\n});`);
		const first = await client.audit(root, { history: true, db });
		const second = await client.audit(root, { history: true, db });
		expect(second.baseline).toEqual(first.report);
		expect(second.policy.failed).toBe(true); // Anonymous identity never becomes persistent by singleton fallback.
		const states = first.report.findings.map((finding) =>
			"identity" in finding ? finding.identity?.state : undefined,
		);
		expect(states.sort()).toEqual(["ambiguous", "identified"]);
		const store = openStore(db);
		try {
			const rows = store.auditRuns(
				repoIdentity(first.report.repo.root, first.report.repo.identity),
			);
			expect(rows.map(storedAuditReport)).toEqual([first.report, second.report]);
		} finally {
			store.close();
		}
	});

	test("reads historical reports without identity and exposes transition refusal in human and JSON output", async () => {
		const modern = await seed(named("alpha"));
		for (const schemaVersion of ["1.0.0", "1.1.0"] as const) {
			const historical: Record<string, unknown> = {
				...modern.report,
				schemaVersion,
				analyzerVersion: "0.2.1",
				findings: modern.report.findings.map(
					({ identity: _identity, ...finding }: Finding) => finding,
				),
			};
			if (schemaVersion === "1.0.0") delete historical.evidence;
			await writeFile(baselinePath, JSON.stringify(historical));
			const loaded = await loadReportArtifact(baselinePath);
			expect(loaded.findings[0]).not.toHaveProperty("identity");
			await writeFile(currentPath, JSON.stringify(modern.report));
			const sdk = await client.compare(baselinePath, currentPath, { configPath });
			expect(sdk.comparison.compatibility.comparable).toBe(false);
			expect(sdk.policy?.failed).toBe(true);
			for (const mode of [[], ["--json"], ["--md"]]) {
				const result = await cli([
					"compare",
					baselinePath,
					currentPath,
					"--config",
					configPath,
					...mode,
				]);
				expect(result.code).toBe(2);
				expect(result.stdout).toContain("fresh schema 1.2.0 baseline");
			}
			const stored = auditReportSchema.parse(historical);
			persist(db, stored);
			const fresh = await client.audit(root, { history: true, db });
			expect(fresh.baseline?.schemaVersion === schemaVersion).toBe(false);
		}
	}, 20_000);
});
