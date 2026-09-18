/**
 * SDK fleet provider-capable parity (SPEC §16.4, §13.1, §11 — plan `pl-43c5`
 * step 20, trellis-f3e5). The fleet is a thin orchestrator over the same
 * `runWorkspaceAudit` the single-repo surfaces fold, so for the same
 * workspaces and the same per-target provider selections these paths must
 * agree: a fleet member's report (normalized evidence, statuses, score) and
 * policy outcome deep-equal a standalone SDK `audit` of that workspace, and
 * the CLI's `trellis fleet` folds the identical aggregate. Only wall-clock run
 * metadata is excluded — the contract already keeps it out of every
 * deterministic comparison.
 *
 * Case matrix mirrors `provider-parity.test.ts` (step 19) at fleet breadth:
 * native-only members, a requested-but-gated capability (located `unsupported`
 * evidence on every host), a real jscpd-complete member (where the pinned tool
 * is installed), a member whose pinned tool is unavailable (a real trellis
 * install whose operator never prepared it), and a required-evidence policy
 * failure — proving one target's provider situation never contaminates
 * another's report, score or the shared exit rollup.
 *
 * Real everything: real temp workspaces, real CLI subprocesses, real copied
 * trellis installs. No filesystem or SQLite stubs; no test fabricates a
 * provider result (the pinned jscpd cases skip where it is not installed).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { providerEntry, seedClonePair, TOOL_AVAILABLE } from "../audit/provider-fixtures.ts";
import * as client from "./index.ts";

/** A fixed instant so SDK-side fleet and standalone runs compare deterministically. */
const NOW = new Date("2026-06-06T00:00:00.000Z");

const MAIN = join(import.meta.dir, "..", "cli", "main.ts");
const REPO = join(import.meta.dir, "..", "..");

/** Spawn the CLI and capture exit code + streams. */
async function runCli(
	args: string[],
	env: Record<string, string> = {},
	opts: { main?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(["bun", "run", opts.main ?? MAIN, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, TRELLIS_LOG_LEVEL: "silent", ...env },
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	return { code, stdout, stderr };
}

/** Drop the wall-clock run metadata so two runs of one workspace compare structurally. */
type NoRun<T> = Omit<T, "run">;

function withoutRun<T extends { run?: unknown }>(value: T): NoRun<T> {
	const { run: _drop, ...rest } = value;
	return rest;
}

/** A fleet report with every volatile timestamp dropped — the comparison shape. */
function comparableFleet(report: client.FleetReport) {
	return {
		...report,
		auditedAt: "<now>",
		entries: report.entries.map((entry) =>
			entry.ok ? { ...entry, report: withoutRun(entry.report) } : entry,
		),
	};
}

/** The runtime packages a trellis install needs to boot (never the pinned tools). */
const RUNTIME_PACKAGES = ["commander", "js-yaml", "typescript", "yaml", "zod"] as const;

/**
 * A real trellis install whose operator did not prepare the pinned provider
 * tool (the step-19 pattern): the repo source copied into a temp tree with
 * only the runtime dependencies linked, so the pinned jscpd resolution
 * fails exactly as it does in the wild.
 */
function installWithoutPinnedTool(): string {
	const install = mkdtempSync(join(tmpdir(), "trellis-fleet-install-"));
	cpSync(join(REPO, "src"), join(install, "src"), { recursive: true });
	mkdirSync(join(install, "node_modules"));
	for (const name of RUNTIME_PACKAGES) {
		symlinkSync(join(REPO, "node_modules", name), join(install, "node_modules", name));
	}
	return install;
}

/**
 * Run one script against `install`'s SDK in a fresh process (the same
 * isolation a CLI spawn gets) and parse its JSON stdout. The script source is
 * provided by the caller so the same seam drives fleet and standalone calls.
 */
async function sdkViaInstall(
	install: string,
	runDir: string,
	name: string,
	source: string,
): Promise<unknown> {
	const runner = join(runDir, `install-${name}.ts`);
	writeFileSync(
		runner,
		`const sdk = await import(${JSON.stringify(pathToFileURL(join(install, "src", "client", "index.ts")).href)});\n` +
			source,
	);
	const proc = Bun.spawn(["bun", "run", runner], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, TRELLIS_LOG_LEVEL: "silent" },
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	if (code !== 0 || stdout.trim().length === 0) {
		throw new Error(`the install SDK script failed (exit ${code}): ${stderr}`);
	}
	return JSON.parse(stdout);
}

describe("client SDK fleet provider-capable parity (SPEC §16.4, §13.1, §11)", () => {
	let dir: string;
	let dbDir: string;
	let targetsFile: string;
	let install: string | undefined;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "trellis-fleet-parity-"));
		dbDir = mkdtempSync(join(tmpdir(), "trellis-fleet-parity-db-"));
		targetsFile = join(dir, "targets.yaml");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		rmSync(dbDir, { recursive: true, force: true });
		if (install !== undefined) rmSync(install, { recursive: true, force: true });
		install = undefined;
	});

	/** Seed `id` as a clone-pair workspace under the parity dir. */
	async function seed(id: string, yaml?: string): Promise<string> {
		const root = join(dir, id);
		await seedClonePair(root);
		if (yaml !== undefined) writeFileSync(join(root, "trellis.yaml"), yaml);
		return root;
	}

	/** Declare the fleet over the given `id: root` pairs. */
	function declareFleet(targets: readonly [string, string][]): void {
		writeFileSync(
			targetsFile,
			`targets:\n${targets.map(([id, root]) => `  - id: ${id}\n    path: ${root}\n`).join("")}`,
		);
	}

	test("a single-target fleet equals the standalone SDK and CLI audits for the same selection", async () => {
		const repo = await seed("gated", "providers:\n  sonarjs: {}\n");
		declareFleet([["gated", repo]]);

		const fleet = await client.fleet(targetsFile, { now: NOW });
		const standalone = await client.audit(repo, { now: NOW });
		expect(fleet.summary).toEqual({ ok: 1, error: 0, policyFailed: 0 });
		const entry = fleet.entries[0];
		if (entry?.ok !== true) throw new Error("expected the fleet member to audit");
		expect(withoutRun(entry.report)).toEqual(withoutRun(standalone.report));
		expect(entry.policy).toEqual(standalone.policy);
		// The requested-but-gated capability carries located unsupported
		// evidence through the fleet exactly as through a single audit.
		const analysis = providerEntry(entry.report, "sonarjs");
		expect(analysis.state).toBe("unsupported");
		expect(analysis.reason).toMatch(/deferred/);

		// The CLI agrees on both surfaces: the fleet aggregate and the
		// standalone audit fold the identical per-target report.
		const cliFleet = await runCli(["fleet", "--targets", targetsFile, "--json"], {
			TRELLIS_DB: "",
		});
		expect(cliFleet.code).toBe(0);
		expect(comparableFleet(JSON.parse(cliFleet.stdout))).toEqual(comparableFleet(fleet));
		const cliAudit = await runCli(["audit", repo, "--json", "--quiet"], { TRELLIS_DB: "" });
		expect(cliAudit.code).toBe(0);
		expect(withoutRun(JSON.parse(cliAudit.stdout))).toEqual(withoutRun(standalone.report));
	}, 20_000);

	test("a mixed fleet keeps per-target scope: each member equals its standalone audit", async () => {
		const gated = await seed("gated", "providers:\n  sonarjs: {}\n");
		const native = await seed("native");
		declareFleet([
			["gated", gated],
			["native", native],
		]);

		const fleet = await client.fleet(targetsFile, { now: NOW });
		expect(fleet.summary).toEqual({ ok: 2, error: 0, policyFailed: 0 });
		for (const [id, root] of [
			["gated", gated],
			["native", native],
		] as const) {
			const entry = fleet.entries.find((e) => e.id === id);
			if (entry?.ok !== true) throw new Error(`expected "${id}" to audit`);
			const standalone = await client.audit(root, { now: NOW });
			// The member's whole report — evidence area included — is exactly
			// the standalone audit's: nothing fleet-level was added, dropped
			// or averaged, and the neighbor's provider scope never leaked.
			expect(withoutRun(entry.report)).toEqual(withoutRun(standalone.report));
			expect(entry.policy).toEqual(standalone.policy);
		}
		// The native member carries no external analysis at all.
		const nativeEntry = fleet.entries.find((e) => e.id === "native");
		if (nativeEntry?.ok !== true || nativeEntry.report.schemaVersion === "1.0.0") {
			throw new Error("expected an evidence-carrying native member");
		}
		expect(
			nativeEntry.report.evidence.analyses.filter((a) => a.provider.kind === "external"),
		).toEqual([]);

		const cliFleet = await runCli(["fleet", "--targets", targetsFile, "--json"], {
			TRELLIS_DB: "",
		});
		expect(cliFleet.code).toBe(0);
		expect(comparableFleet(JSON.parse(cliFleet.stdout))).toEqual(comparableFleet(fleet));
	}, 20_000);

	test.skipIf(!TOOL_AVAILABLE)(
		"a jscpd-complete member equals the standalone SDK and CLI audits",
		async () => {
			const cloned = await seed("cloned", "providers:\n  jscpd:\n    mode: exact\n");
			const native = await seed("native");
			declareFleet([
				["cloned", cloned],
				["native", native],
			]);

			const fleet = await client.fleet(targetsFile, { now: NOW });
			const entry = fleet.entries.find((e) => e.id === "cloned");
			if (entry?.ok !== true) throw new Error("expected the jscpd member to audit");
			const analysis = providerEntry(entry.report, "jscpd");
			expect(analysis.state).toBe("complete");
			expect(analysis.scoring).toBe("advisory");
			const standalone = await client.audit(cloned, { now: NOW });
			expect(withoutRun(entry.report)).toEqual(withoutRun(standalone.report));
			expect(entry.policy).toEqual(standalone.policy);
			// The CLI's fleet and standalone audits fold the same member report.
			const cliFleet = await runCli(["fleet", "--targets", targetsFile, "--json"], {
				TRELLIS_DB: "",
			});
			expect(cliFleet.code).toBe(0);
			expect(comparableFleet(JSON.parse(cliFleet.stdout))).toEqual(comparableFleet(fleet));
			const cliAudit = await runCli(["audit", cloned, "--json", "--quiet"], { TRELLIS_DB: "" });
			expect(withoutRun(JSON.parse(cliAudit.stdout))).toEqual(withoutRun(standalone.report));
			// The native neighbor still carries no external evidence.
			const nativeEntry = fleet.entries.find((e) => e.id === "native");
			if (nativeEntry?.ok !== true || nativeEntry.report.schemaVersion === "1.0.0") {
				throw new Error("expected an evidence-carrying native member");
			}
			expect(
				nativeEntry.report.evidence.analyses.filter((a) => a.provider.kind === "external"),
			).toEqual([]);
		},
		20_000,
	);

	test("an unavailable pinned tool is located evidence per member, SDK and CLI identical", async () => {
		install = installWithoutPinnedTool();
		const cloned = await seed("cloned", "providers:\n  jscpd:\n    mode: exact\n");
		const native = await seed("native");
		declareFleet([
			["cloned", cloned],
			["native", native],
		]);

		// The install's SDK runs the fleet in a fresh process (the same
		// isolation a CLI spawn gets), pinned to the shared clock.
		const fleet = (await sdkViaInstall(
			install,
			dbDir,
			"fleet",
			`const report = await sdk.fleet(${JSON.stringify(targetsFile)}, { now: new Date(${JSON.stringify(NOW.toISOString())}) });
console.log(JSON.stringify(report));\n`,
		)) as client.FleetReport;
		expect(fleet.summary).toEqual({ ok: 2, error: 0, policyFailed: 0 });
		const entry = fleet.entries.find((e) => e.id === "cloned");
		if (entry?.ok !== true) throw new Error("expected the jscpd member to audit");
		const analysis = providerEntry(entry.report, "jscpd");
		expect(analysis.state).toBe("unavailable");
		expect(analysis.reason).toContain("is not installed");
		// Honest completeness (§16.2): the gap is recorded while the native
		// score stays complete — and the native neighbor is untouched.
		if (entry.report.schemaVersion === "1.0.0") throw new Error("expected evidence area");
		expect(entry.report.evidence.completeness).toBe("incomplete");
		expect(entry.report.score.partial).toBe(false);
		const nativeEntry = fleet.entries.find((e) => e.id === "native");
		if (nativeEntry?.ok !== true) throw new Error("expected the native member to audit");
		const nativeStandalone = (await sdkViaInstall(
			install,
			dbDir,
			"native-audit",
			`const result = await sdk.audit(${JSON.stringify(native)}, { now: new Date(${JSON.stringify(NOW.toISOString())}) });
console.log(JSON.stringify(result));\n`,
		)) as client.WorkspaceAuditResult;
		expect(withoutRun(nativeEntry.report)).toEqual(withoutRun(nativeStandalone.report));

		// The CLI through the same install folds the identical aggregate.
		const cliFleet = await runCli(
			["fleet", "--targets", targetsFile, "--json"],
			{
				TRELLIS_DB: "",
			},
			{ main: join(install, "src", "cli", "main.ts") },
		);
		expect(cliFleet.code).toBe(0);
		expect(comparableFleet(JSON.parse(cliFleet.stdout))).toEqual(comparableFleet(fleet));
	}, 20_000);

	test("required-evidence unavailability trips the fleet exit contract identically", async () => {
		install = installWithoutPinnedTool();
		const required = await seed(
			"required",
			"policy:\n  requireEvidence: [jscpd]\nproviders:\n  jscpd:\n    mode: exact\n",
		);
		const native = await seed("native");
		declareFleet([
			["required", required],
			["native", native],
		]);

		const fleet = (await sdkViaInstall(
			install,
			dbDir,
			"fleet-required",
			`const report = await sdk.fleet(${JSON.stringify(targetsFile)}, { now: new Date(${JSON.stringify(NOW.toISOString())}) });
console.log(JSON.stringify({ report, assessment: sdk.assessFleet(report) }));\n`,
		)) as { report: client.FleetReport; assessment: client.FleetAssessment };
		expect(fleet.report.summary).toEqual({ ok: 2, error: 0, policyFailed: 1 });
		expect(fleet.assessment.failed).toBe(true);
		expect(fleet.assessment.reasons.join(" ")).toContain(
			'required analysis "jscpd" is unavailable',
		);

		// The CLI maps the identical assessment onto exit 2 with the report
		// still emitted and the reason on stderr; the native member is a
		// clean survivor of the shared rollup.
		const cliFleet = await runCli(
			["fleet", "--targets", targetsFile, "--json"],
			{
				TRELLIS_DB: "",
			},
			{ main: join(install, "src", "cli", "main.ts") },
		);
		expect(cliFleet.code).toBe(2);
		expect(comparableFleet(JSON.parse(cliFleet.stdout))).toEqual(comparableFleet(fleet.report));
		expect(cliFleet.stderr).toContain('required analysis "jscpd" is unavailable');
	}, 20_000);
});
