import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedClonePair, TOOL_AVAILABLE } from "../audit/provider-fixtures.ts";

/**
 * `trellis audit --provider` (SPEC §16.4, plan `pl-43c5` step 18 —
 * trellis-5ee9): the CLI's minimal provider-selection surface over the same
 * core service. Real CLI subprocesses over real temp workspaces exercise:
 *
 * - flag translation into the declarative `providers` block the core accepts,
 *   with fail-fast rejection of unknown ids, duplicate/conflicting
 *   selections, a missing jscpd match mode and flag options on providers
 *   whose requests are declarative (operational exit 1, SPEC §16.3);
 * - per-provider precedence: a flagged provider overrides its `trellis.yaml`
 *   entry, unflagged providers keep theirs;
 * - the honest evidence states through the real CLI — `complete` for a
 *   configured jscpd (where the pinned tool is installed), `unsupported`
 *   for gated ids, `unavailable` for a CLI install whose
 *   operator never prepared the pinned tool (a real copied install with the
 *   tool absent, so resolution fails exactly as it would in the wild);
 * - the exit-code contract: a required provider that cannot run is policy
 *   (exit 2, report still on stdout), a bad selection is operational
 *   (exit 1, no report);
 * - `--out`/`--json` honoring the same provider-aware report, with provider
 *   diagnostics never corrupting machine-readable stdout.
 */

const MAIN = join(import.meta.dir, "main.ts");
const REPO = join(import.meta.dir, "..", "..");

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

/** The runtime packages a trellis CLI install needs to boot (never the pinned tools). */
const RUNTIME_PACKAGES = ["commander", "js-yaml", "typescript", "yaml", "zod"] as const;

/**
 * A real trellis CLI install whose operator did not prepare the pinned
 * provider tool: the repo source copied into a temp tree with only the
 * runtime dependencies linked, so the pinned jscpd resolution fails exactly
 * as it does in the wild (located `unavailable` evidence, §16.3).
 */
function installCliWithoutPinnedTool(): string {
	const install = mkdtempSync(join(tmpdir(), "trellis-cli-install-"));
	cpSync(join(REPO, "src"), join(install, "src"), { recursive: true });
	mkdirSync(join(install, "node_modules"));
	for (const name of RUNTIME_PACKAGES) {
		symlinkSync(join(REPO, "node_modules", name), join(install, "node_modules", name));
	}
	return install;
}

type ReportShape = {
	score: { index: number };
	metrics: Record<string, unknown>;
	evidence: {
		analyses: {
			provider: { id: string; kind: string; mode?: string };
			state: string;
			reason?: string;
			metrics?: { id: string }[];
		}[];
	};
};

/** Parse a CLI `--json` report (fails fast on non-JSON stdout). */
function parseReport(stdout: string): ReportShape {
	return JSON.parse(stdout) as ReportShape;
}

/** The report's external (provider) evidence entries. */
function externalEntries(report: ReportShape) {
	return report.evidence.analyses.filter((entry) => entry.provider.kind === "external");
}

/** The external entry of `providerId` (fails fast when absent). */
function providerEntry(report: ReportShape, providerId: string) {
	const entry = externalEntries(report).find((e) => e.provider.id === providerId);
	if (entry === undefined) throw new Error(`expected "${providerId}" evidence`);
	return entry;
}

describe("trellis audit --provider (provider selection, SPEC §16.4)", () => {
	let dir: string;
	let dbDir: string;
	let dbPath: string;
	let install: string | undefined;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "trellis-cli-providers-"));
		await seedClonePair(dir);
		dbDir = mkdtempSync(join(tmpdir(), "trellis-cli-db-"));
		dbPath = join(dbDir, "trellis.db");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		rmSync(dbDir, { recursive: true, force: true });
		if (install !== undefined) rmSync(install, { recursive: true, force: true });
		install = undefined;
	});

	test.skipIf(!TOOL_AVAILABLE)(
		"adds complete advisory evidence without touching the native score",
		async () => {
			// Native default: no external evidence, and (with a provider selected)
			// the score and the native metrics map stay identical — evidence is
			// additive, never scored (§16.5).
			const nativeRun = await runCli(["audit", dir, "--json", "--quiet"], { TRELLIS_DB: dbPath });
			expect(nativeRun.code).toBe(0);
			const native = parseReport(nativeRun.stdout);
			expect(externalEntries(native)).toEqual([]);
			const run = await runCli(["audit", dir, "--json", "--quiet", "--provider", "jscpd:exact"], {
				TRELLIS_DB: dbPath,
			});
			expect(run.code).toBe(0);
			const report = parseReport(run.stdout);
			const entry = providerEntry(report, "jscpd");
			expect(entry.state).toBe("complete");
			expect(entry.provider.mode).toBe("exact");
			expect(entry.metrics?.map((m) => m.id)).toContain("provider.jscpd.duplication.clone-pairs");
			expect(report.score.index).toBe(native.score.index);
			expect(Object.keys(report.metrics).some((id) => id.startsWith("provider."))).toBe(false);
		},
		20_000,
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"the trellis.yaml providers block configures the same core path",
		async () => {
			writeFileSync(join(dir, "trellis.yaml"), "providers:\n  jscpd:\n    mode: normalized\n");
			const run = await runCli(["audit", dir, "--json", "--quiet"], { TRELLIS_DB: dbPath });
			expect(run.code).toBe(0);
			const entry = providerEntry(parseReport(run.stdout), "jscpd");
			expect(entry.state).toBe("complete");
			expect(entry.provider.mode).toBe("normalized");
		},
		20_000,
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"flag selections apply per provider over the trellis.yaml providers block",
		async () => {
			writeFileSync(
				join(dir, "trellis.yaml"),
				"providers:\n  jscpd:\n    mode: exact\n  knip: {}\n",
			);
			const run = await runCli(["audit", dir, "--json", "--quiet", "--provider", "jscpd:near"], {
				TRELLIS_DB: dbPath,
			});
			expect(run.code).toBe(0);
			const report = parseReport(run.stdout);
			// The flag wins for jscpd; the file's knip entry is kept and its
			// adapter runs per request (no entry declared → contextual orphan
			// candidates over an undefined reachability model).
			expect(providerEntry(report, "jscpd").provider.mode).toBe("near");
			const knip = providerEntry(report, "knip");
			expect(knip.state).toBe("complete");
			expect(knip.provider.mode).toBe("contextual");
		},
		20_000,
	);

	test("rejects unknown, conflicting and malformed selections fast (exit 1)", async () => {
		const cases: { args: string[]; stderrContains: string }[] = [
			{
				args: ["--provider", "foo"],
				stderrContains: 'unknown provider "foo" in --provider foo',
			},
			{
				args: ["--provider", "jscpd"],
				stderrContains: 'provider "jscpd" needs a match mode',
			},
			{
				args: ["--provider", "jscpd:fuzzy"],
				stderrContains: 'unknown jscpd match mode "fuzzy"',
			},
			{
				args: ["--provider", "knip", "--provider", "knip"],
				stderrContains: 'provider "knip" is selected more than once',
			},
			{
				args: ["--provider", "jscpd:exact", "--provider", "jscpd:near"],
				stderrContains: 'conflicting --provider selections for "jscpd"',
			},
			{
				args: ["--provider", "sonarjs:rules"],
				stderrContains: 'provider "sonarjs" takes no flag options',
			},
		];
		for (const { args, stderrContains } of cases) {
			const run = await runCli(["audit", dir, "--quiet", ...args], { TRELLIS_DB: dbPath });
			expect(run.code).toBe(1);
			expect(run.stdout).toBe("");
			expect(run.stderr).toContain(stderrContains);
		}
	}, 20_000);

	test("requests gated providers as located unsupported evidence (exit 0)", async () => {
		const sonar = await runCli(["audit", dir, "--json", "--quiet", "--provider", "sonarjs"], {
			TRELLIS_DB: dbPath,
		});
		expect(sonar.code).toBe(0);
		const sonarEntry = providerEntry(parseReport(sonar.stdout), "sonarjs");
		expect(sonarEntry.state).toBe("unsupported");
		expect(sonarEntry.reason).toContain("deferred");
		// Provider diagnostics ride inside the report's evidence area (stdout
		// stays machine-clean JSON) and never on stdout outside the report.
		expect(sonar.stderr).toBe("");
	}, 20_000);

	test.skipIf(!TOOL_AVAILABLE)(
		"requests the delivered knip adapter as advisory evidence without touching the score (exit 0)",
		async () => {
			const nativeRun = await runCli(["audit", dir, "--json", "--quiet"], {
				TRELLIS_DB: dbPath,
			});
			expect(nativeRun.code).toBe(0);
			const knip = await runCli(["audit", dir, "--json", "--quiet", "--provider", "knip"], {
				TRELLIS_DB: dbPath,
			});
			expect(knip.code).toBe(0);
			const report = parseReport(knip.stdout);
			const knipEntry = providerEntry(report, "knip");
			expect(knipEntry.state).toBe("complete");
			expect(knipEntry.provider.mode).toBe("contextual");
			expect(knipEntry.metrics?.map((metric) => metric.id)).toContain(
				"provider.knip.candidates.total",
			);
			// Advisory evidence never touches the native score or the native metrics.
			expect(report.score.index).toBe(parseReport(nativeRun.stdout).score.index);
			expect(Object.keys(report.metrics).some((id) => id.startsWith("provider."))).toBe(false);
			expect(knip.stderr).toBe("");
		},
		20_000,
	);

	test("a missing pinned tool is located unavailable evidence, never an abort", async () => {
		install = installCliWithoutPinnedTool();
		const run = await runCli(
			["audit", dir, "--json", "--quiet", "--provider", "jscpd:exact"],
			{ TRELLIS_DB: dbPath },
			{ main: join(install, "src", "cli", "main.ts") },
		);
		expect(run.code).toBe(0);
		const entry = providerEntry(parseReport(run.stdout), "jscpd");
		expect(entry.state).toBe("unavailable");
		expect(entry.reason).toContain("is not installed");
		expect(entry.reason).toContain("never at audit time");
	}, 20_000);

	test("a required unavailable provider trips policy (exit 2), not an abort", async () => {
		install = installCliWithoutPinnedTool();
		writeFileSync(join(dir, "trellis.yaml"), "policy:\n  requireEvidence: [jscpd]\n");
		const run = await runCli(
			["audit", dir, "--json", "--quiet", "--provider", "jscpd:exact"],
			{ TRELLIS_DB: dbPath },
			{ main: join(install, "src", "cli", "main.ts") },
		);
		expect(run.code).toBe(2);
		// The report is still emitted, with the located evidence.
		expect(providerEntry(parseReport(run.stdout), "jscpd").state).toBe("unavailable");
		expect(run.stderr).toContain("policy evidence-requirement failed");
		expect(run.stderr).toContain('required analysis "jscpd"');
	}, 20_000);

	test("an unrequested required provider fails closed (exit 2)", async () => {
		writeFileSync(join(dir, "trellis.yaml"), "policy:\n  requireEvidence: [jscpd]\n");
		const run = await runCli(["audit", dir, "--json", "--quiet"], { TRELLIS_DB: dbPath });
		expect(run.code).toBe(2);
		expect(run.stderr).toContain("policy evidence-requirement failed");
		expect(run.stderr).toContain("the run did not request it");
		// No provider was requested, so the report carries no external evidence.
		expect(externalEntries(parseReport(run.stdout))).toEqual([]);
	}, 20_000);

	test("a required deferred capability fails closed (exit 2)", async () => {
		writeFileSync(join(dir, "trellis.yaml"), "policy:\n  requireEvidence: [sonarjs]\n");
		const run = await runCli(["audit", dir, "--json", "--quiet", "--provider", "sonarjs"], {
			TRELLIS_DB: dbPath,
		});
		expect(run.code).toBe(2);
		expect(providerEntry(parseReport(run.stdout), "sonarjs").state).toBe("unsupported");
		expect(run.stderr).toContain("policy evidence-requirement failed");
		expect(run.stderr).toContain('required analysis "sonarjs" is unsupported');
		expect(run.stderr).toContain("deferred");
	}, 20_000);

	test.skipIf(!TOOL_AVAILABLE)(
		"--out writes the same provider-aware report while stdout stays human",
		async () => {
			const out = join(dbDir, "report.json");
			// No --quiet: the write notice lands on stderr (progress stays silent off-TTY).
			const run = await runCli(["audit", dir, "--provider", "jscpd:exact", "--out", out], {
				TRELLIS_DB: dbPath,
			});
			expect(run.code).toBe(0);
			const artifact = parseReport(readFileSync(out, "utf8"));
			expect(providerEntry(artifact, "jscpd").state).toBe("complete");
			expect(run.stdout).not.toContain('"schemaVersion"');
			expect(run.stderr).toContain("report written to");
		},
		20_000,
	);

	test("help documents selection, local install prerequisites and scratch behavior", async () => {
		const { code, stdout } = await runCli(["audit", "--help"]);
		expect(code).toBe(0);
		expect(stdout).toContain("--provider <id[:mode]>");
		expect(stdout).toContain("must already be installed");
		expect(stdout).toContain("never installs or fetches tools");
		expect(stdout).toContain("scratch");
		// No audit-time installation or target-command surface exists.
		expect(stdout).not.toContain("--install");
	}, 20_000);
});
