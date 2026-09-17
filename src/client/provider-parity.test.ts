import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runWorkspaceAudit } from "../audit/index.ts";
import {
	providerAuditConfig,
	providerEntry,
	seedClonePair,
	TOOL_AVAILABLE,
} from "../audit/provider-fixtures.ts";
import { loadAuditConfig } from "../config/index.ts";
import { auditReportSchema } from "../contract/index.ts";
import { renderAuditJson } from "../report/audit-json.ts";
import * as client from "./index.ts";

/**
 * SDK provider-capable parity (SPEC §16.4, §13.1, plan `pl-43c5` step 19 —
 * trellis-ad4b). The SDK's `audit` folds the same core service the CLI's
 * `--provider` surface folds, so for the same workspace and the same
 * provider selection the three paths — direct core (`runWorkspaceAudit`),
 * SDK (`client.audit`) and CLI (`trellis audit --provider`) — must produce
 * deep-equal reports (normalized native/jscpd evidence, statuses, score)
 * and identical policy outcomes. The only excluded fields are the wall-clock
 * run metadata (`run.auditedAt`, `run.durationMs`) the contract already
 * keeps out of every deterministic comparison.
 *
 * Real everything: real temp workspaces, real CLI subprocesses, and a real
 * copied trellis install whose operator never prepared the pinned tool (the
 * same pattern as `src/cli/audit-providers.test.ts`), so an unavailable
 * provider fails exactly as it would in the wild. No filesystem or SQLite
 * stubs; the pinned jscpd cases skip (never fabricate) where the pinned tool
 * is not installed on the host.
 */

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
function withoutRun<T extends { run?: unknown }>(value: T): Omit<T, "run"> {
	const { run: _drop, ...rest } = value;
	return rest;
}

/** The external (provider) analyses a report carries, by provider id. */
function externalProviderIds(report: client.AuditReport): string[] {
	if (report.schemaVersion !== "1.1.0") return [];
	return report.evidence.analyses
		.filter((analysis) => analysis.provider.kind === "external")
		.map((analysis) => analysis.provider.id);
}

/** The runtime packages a trellis install needs to boot (never the pinned tools). */
const RUNTIME_PACKAGES = ["commander", "js-yaml", "typescript", "yaml", "zod"] as const;

/**
 * A real trellis install whose operator did not prepare the pinned provider
 * tool: the repo source copied into a temp tree with only the runtime
 * dependencies linked, so the pinned jscpd resolution fails exactly as it
 * does in the wild (located `unavailable` evidence, §16.3).
 */
function installWithoutPinnedTool(): string {
	const install = mkdtempSync(join(tmpdir(), "trellis-sdk-install-"));
	cpSync(join(REPO, "src"), join(install, "src"), { recursive: true });
	mkdirSync(join(install, "node_modules"));
	for (const name of RUNTIME_PACKAGES) {
		symlinkSync(join(REPO, "node_modules", name), join(install, "node_modules", name));
	}
	return install;
}

/**
 * Run one SDK `audit` call over `install`'s SDK in a fresh process — the same
 * isolation a CLI spawn gets — so the copied module tree never loads inside
 * the test worker (and the pinned tools resolve from that install's
 * `node_modules` chain, exactly as a programmatic caller of the installed
 * SDK gets). Real execution, not a stub: the runner prints the full
 * `WorkspaceAuditResult` as JSON.
 */
async function auditViaInstall(
	install: string,
	runDir: string,
	repoPath: string,
	opts: { config?: unknown; configPath?: string } = {},
): Promise<client.WorkspaceAuditResult> {
	const runner = join(runDir, "install-sdk-audit.ts");
	writeFileSync(
		runner,
		`const sdk = await import(${JSON.stringify(pathToFileURL(join(install, "src", "client", "index.ts")).href)});
` +
			`const result = await sdk.audit(${JSON.stringify(repoPath)}, JSON.parse(${JSON.stringify(JSON.stringify(opts))}));
` +
			"console.log(JSON.stringify(result));\n",
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
		throw new Error(`the install SDK audit failed (exit ${code}): ${stderr}`);
	}
	return JSON.parse(stdout) as client.WorkspaceAuditResult;
}

/** The failed policy reason of the first failing policy result (fails fast when absent). */
function failedReason(result: { policy: client.PolicyAssessment }) {
	const reason = result.policy.results.find((r) => r.status === "fail")?.reasons[0];
	if (reason === undefined) throw new Error("expected a failed policy reason");
	return reason;
}

describe("client SDK provider-capable parity (SPEC §16.4, §13.1)", () => {
	let dir: string;
	let dbDir: string;
	let dbPath: string;
	let install: string | undefined;

	beforeEach(async () => {
		// A real clone-pair workspace — the fixture the provider suites share.
		dir = mkdtempSync(join(tmpdir(), "trellis-sdk-providers-"));
		await seedClonePair(dir);
		dbDir = mkdtempSync(join(tmpdir(), "trellis-sdk-providers-db-"));
		dbPath = join(dbDir, "trellis.db");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		rmSync(dbDir, { recursive: true, force: true });
		if (install !== undefined) rmSync(install, { recursive: true, force: true });
		install = undefined;
	});

	test.skipIf(!TOOL_AVAILABLE)(
		"core, SDK and CLI return deep-equal jscpd evidence and policy outcomes",
		async () => {
			// The exact configuration the CLI's --provider translation produces:
			// the workspace's resolved base with the selection applied per provider.
			const base = await loadAuditConfig(dir);
			const config: client.AuditConfig = {
				...base,
				providers: { ...base.providers, jscpd: { mode: "exact" } },
			};
			const core = await runWorkspaceAudit(dir, { config });
			const sdk = await client.audit(dir, { config });
			expect(withoutRun(core.report)).toEqual(withoutRun(sdk.report));
			expect(core.policy.failed).toBe(false);
			expect(sdk.policy.failed).toBe(core.policy.failed);
			const cli = await runCli(["audit", dir, "--json", "--quiet", "--provider", "jscpd:exact"], {
				TRELLIS_DB: dbPath,
			});
			expect(cli.code).toBe(0);
			expect(withoutRun(sdk.report)).toEqual(withoutRun(JSON.parse(cli.stdout)));

			// The carried jscpd evidence: complete, advisory, namespaced — and
			// identical no matter which of the three surfaces produced it.
			const entry = providerEntry(sdk.report, "jscpd");
			expect(entry.state).toBe("complete");
			expect(entry.provider.mode).toBe("exact");
			expect(entry.scoring).toBe("advisory");
			expect(entry.metrics?.map((metric) => metric.id)).toContain(
				"provider.jscpd.duplication.clone-pairs",
			);

			// Optional-provider absence: the default native run carries no external
			// evidence, no namespaced metric in the map, and the same score —
			// existing callers that pass no provider fields see today's behavior.
			const native = await client.audit(dir);
			expect(native.report.score.index).toBe(sdk.report.score.index);
			expect(native.report.score.partial).toBe(false);
			expect(externalProviderIds(native.report)).toEqual([]);
			expect(Object.keys(sdk.report.metrics).some((id) => id.startsWith("provider."))).toBe(false);
		},
		20_000,
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"the trellis.yaml providers block configures the same core path through SDK and CLI",
		async () => {
			writeFileSync(join(dir, "trellis.yaml"), "providers:\n  jscpd:\n    mode: normalized\n");
			const sdk = await client.audit(dir);
			const cli = await runCli(["audit", dir, "--json", "--quiet"], { TRELLIS_DB: dbPath });
			expect(cli.code).toBe(0);
			expect(withoutRun(sdk.report)).toEqual(withoutRun(JSON.parse(cli.stdout)));
			const entry = providerEntry(sdk.report, "jscpd");
			expect(entry.state).toBe("complete");
			expect(entry.provider.mode).toBe("normalized");
		},
		20_000,
	);

	test("a missing pinned tool is located unavailable evidence through SDK and CLI alike", async () => {
		install = installWithoutPinnedTool();
		// The merged config the CLI's --provider jscpd:exact translation produces.
		const sdk = await auditViaInstall(install, dbDir, dir, {
			config: providerAuditConfig({ jscpd: { mode: "exact" } }),
		});
		expect(sdk.policy.failed).toBe(false);
		const entry = providerEntry(sdk.report, "jscpd");
		expect(entry.state).toBe("unavailable");
		expect(entry.reason).toContain("is not installed");
		expect(entry.reason).toContain("never at audit time");
		// Honest completeness (§16.2): the evidence area records the gap while
		// the native score stays complete — advisory evidence never scores.
		if (sdk.report.schemaVersion !== "1.1.0")
			throw new Error("expected an evidence-carrying report");
		expect(sdk.report.evidence.completeness).toBe("incomplete");
		expect(sdk.report.score.partial).toBe(false);
		const cli = await runCli(
			["audit", dir, "--json", "--quiet", "--provider", "jscpd:exact"],
			{ TRELLIS_DB: dbPath },
			{ main: join(install, "src", "cli", "main.ts") },
		);
		expect(cli.code).toBe(0);
		expect(withoutRun(sdk.report)).toEqual(withoutRun(JSON.parse(cli.stdout)));
	}, 20_000);

	test("required evidence that cannot run trips policy identically through SDK and CLI", async () => {
		install = installWithoutPinnedTool();
		writeFileSync(
			join(dir, "trellis.yaml"),
			"policy:\n  requireEvidence: [jscpd]\nproviders:\n  jscpd:\n    mode: exact\n",
		);
		const sdk = await auditViaInstall(install, dbDir, dir);
		expect(sdk.policy.failed).toBe(true);
		const reason = failedReason(sdk);
		expect(reason.code).toBe("requirement-evidence-unavailable");
		expect(reason.message).toContain('required analysis "jscpd" is unavailable');
		expect(providerEntry(sdk.report, "jscpd").state).toBe("unavailable");
		const cli = await runCli(
			["audit", dir, "--json", "--quiet"],
			{ TRELLIS_DB: dbPath },
			{ main: join(install, "src", "cli", "main.ts") },
		);
		expect(cli.code).toBe(2);
		// The report is still emitted, byte-for-byte the SDK's.
		expect(withoutRun(sdk.report)).toEqual(withoutRun(JSON.parse(cli.stdout)));
		expect(cli.stderr).toContain(reason.message);
	}, 20_000);

	test("a required provider the run never requested fails closed through SDK and CLI", async () => {
		writeFileSync(join(dir, "trellis.yaml"), "policy:\n  requireEvidence: [jscpd]\n");
		const sdk = await client.audit(dir);
		expect(sdk.policy.failed).toBe(true);
		const reason = failedReason(sdk);
		expect(reason.code).toBe("requirement-analysis-unrequested");
		expect(reason.message).toContain("the run did not request it");
		expect(externalProviderIds(sdk.report)).toEqual([]);
		const cli = await runCli(["audit", dir, "--json", "--quiet"], { TRELLIS_DB: dbPath });
		expect(cli.code).toBe(2);
		expect(withoutRun(sdk.report)).toEqual(withoutRun(JSON.parse(cli.stdout)));
		expect(cli.stderr).toContain(reason.message);
	}, 20_000);

	test("a requested deferred capability carries unsupported evidence and fails policy identically", async () => {
		writeFileSync(join(dir, "trellis.yaml"), "policy:\n  requireEvidence: [sonarjs]\n");
		// The merged config the CLI's --provider sonarjs translation produces:
		// the flag's request over the file's providers block.
		const base = await loadAuditConfig(dir);
		const config: client.AuditConfig = {
			...base,
			providers: { ...base.providers, sonarjs: {} },
		};
		const sdk = await client.audit(dir, { config });
		const entry = providerEntry(sdk.report, "sonarjs");
		expect(entry.state).toBe("unsupported");
		expect(entry.reason).toContain("deferred");
		expect(sdk.policy.failed).toBe(true);
		const reason = failedReason(sdk);
		expect(reason.code).toBe("requirement-evidence-unsupported");
		const cli = await runCli(["audit", dir, "--json", "--quiet", "--provider", "sonarjs"], {
			TRELLIS_DB: dbPath,
		});
		expect(cli.code).toBe(2);
		expect(withoutRun(sdk.report)).toEqual(withoutRun(JSON.parse(cli.stdout)));
		expect(cli.stderr).toContain(reason.message);
	}, 20_000);

	test("compare() reads old artifacts as unrequested evidence, never regressions (CLI parity)", async () => {
		// A provider-carrying current report (the deferred sonarjs capability is
		// located unsupported evidence on every host — no pinned tool needed).
		const current = await client.audit(dir, {
			config: providerAuditConfig({ sonarjs: {} }),
		});
		if (current.report.schemaVersion !== "1.1.0") {
			throw new Error("expected the evidence-carrying report");
		}
		expect(current.report.score.partial).toBe(false);
		expect(current.report.evidence.completeness).toBe("incomplete");
		// The pre-provider (1.0.0) artifact: the same measurement body minus
		// the evidence area — exactly what an older trellis wrote for this run.
		const { evidence: _drop, ...body } = current.report;
		const old = auditReportSchema.parse({ ...body, schemaVersion: "1.0.0" });
		const oldPath = join(dbDir, "old.json");
		const currentPath = join(dbDir, "current.json");
		writeFileSync(oldPath, renderAuditJson(old));
		writeFileSync(currentPath, renderAuditJson(current.report));
		const sdk = await client.compare(oldPath, currentPath);
		expect(sdk.policy).toBeNull();
		// The scored basis is unchanged across the schema span, so the pair
		// still compares — with the schema-span caveat, not a refusal.
		expect(sdk.comparison.compatibility.comparable).toBe(true);
		expect(sdk.comparison.compatibility.caveats.map((caveat) => caveat.code)).toContain(
			"schema-span",
		);
		// The pre-provider side reads as unrequested — never a regression.
		const sonarjs = sdk.comparison.evidence.providers.find((p) => p.providerId === "sonarjs");
		expect(sonarjs?.status).toBe("absent-on-baseline");
		expect(sonarjs?.baseline.state).toBe("unrequested");
		expect(sonarjs?.reasons.map((issue) => issue.message).join(" ")).toContain(
			"never as a regression",
		);
		const cli = await runCli(["compare", oldPath, currentPath, "--json"]);
		expect(cli.code).toBe(0);
		expect(sdk.comparison).toEqual(JSON.parse(cli.stdout));
	}, 20_000);

	test("invalid provider selections reject as typed operational errors, CLI exit-1 equivalent", async () => {
		const cases: { yaml: string; message: RegExp }[] = [
			{ yaml: "providers:\n  frobnicator: {}\n", message: /frobnicator/ },
			{ yaml: "providers:\n  jscpd:\n    mode: fuzzy\n", message: /providers\.jscpd\.mode/ },
			{ yaml: "providers:\n  sonarjs:\n    rules: []\n", message: /sonarjs/ },
		];
		for (const { yaml, message } of cases) {
			const configPath = join(dir, "trellis.yaml");
			writeFileSync(configPath, yaml);
			// The SDK surfaces the core's typed operational error…
			let sdkMessage = "no error thrown";
			try {
				await client.audit(dir, { configPath });
			} catch (error) {
				sdkMessage = error instanceof Error ? error.message : String(error);
			}
			expect(sdkMessage).toMatch(message);
			// …and the CLI maps the identical core error onto exit 1.
			const cli = await runCli(["audit", dir, "--config", configPath, "--quiet"], {
				TRELLIS_DB: dbPath,
			});
			expect(cli.code).toBe(1);
			expect(cli.stdout).toBe("");
			expect(cli.stderr).toContain(sdkMessage);
		}
	}, 20_000);
});
