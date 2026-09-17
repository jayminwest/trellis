/**
 * Terminal rendering of the optional-provider evidence section (SPEC §6.6,
 * §16.2 — plan `pl-43c5` step 16, trellis-fc9c).
 *
 * Every report is produced by the real deterministic core over a real temp
 * repository (`auditWorkspace` with a declarative provider selection); the
 * real-binary cases skip where the pinned jscpd artifact is not installed,
 * exactly like the provider-selection core tests. The one exception — an
 * `unrequested` external entry, contract-valid but not emitted by today's
 * core — is appended additively to a real core report and re-validated
 * through `auditReportSchema` before rendering.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditWorkspace } from "../audit/audit.ts";
import {
	CLONE_FN,
	PINNED,
	providerAuditConfig,
	putFile,
	seedClonePair,
	TOOL_AVAILABLE,
} from "../audit/provider-fixtures.ts";
import {
	type AuditReport,
	auditReportSchema,
	measurementPayload,
	type ReportAnalysis,
} from "../contract/index.ts";
import { renderAuditTerminal } from "./audit-terminal.ts";

/** A second, distinct clone fixture (above every threshold, different content). */
const CLONE_RENAMED = CLONE_FN.replace(/alpha/g, "omega");

/** The section title the renderer emits when provider evidence is carried. */
const SECTION_TITLE =
	"provider analyses (optional engineering evidence — never folded into the score)";

let repo: string;

beforeEach(async () => {
	repo = await mkdtemp(join(tmpdir(), "trellis-terminal-providers-"));
});

afterEach(async () => {
	await rm(repo, { recursive: true, force: true });
});

/** Audit `repo` through the one core with the given provider selection. */
async function audit(
	providers: Parameters<typeof providerAuditConfig>[0],
	policy?: Parameters<typeof providerAuditConfig>[1],
): Promise<AuditReport> {
	return auditWorkspace(repo, {
		config: providerAuditConfig(providers, policy),
		now: PINNED,
	});
}

/** The rendered terminal report of `repo`'s audit. */
async function render(
	providers: Parameters<typeof providerAuditConfig>[0],
	policy?: Parameters<typeof providerAuditConfig>[1],
): Promise<string> {
	return renderAuditTerminal(await audit(providers, policy));
}

/** Terminal output is plain text: no ANSI escape codes anywhere (SPEC §12). */
function expectPlain(output: string): void {
	expect(output).not.toContain("[");
}

/** The headline sloppiness line of a rendered report. */
function headline(output: string): string {
	const line = output.split("\n").find((candidate) => candidate.includes("sloppiness index"));
	if (line === undefined) throw new Error("rendered report has no score headline");
	return line;
}

/** Strip the run-metadata line (timestamp and duration) — the only rendered nondeterminism. */
function withoutRunLine(output: string): string {
	return output.replace(/audited [^\n]*/, "audited <run>");
}

describe("renderAuditTerminal without optional providers", () => {
	test("renders a native-only audit with no provider section and no provider noise", async () => {
		await seedClonePair(repo);
		const output = renderAuditTerminal(await auditWorkspace(repo, { now: PINNED }));
		expectPlain(output);
		expect(output).not.toContain(SECTION_TITLE);
		expect(output).not.toContain("evidence:");
		expect(output).not.toMatch(/provider\.[a-z]/);
		expect(headline(output)).not.toContain("PARTIAL");
	});

	test("renders an empty providers block byte-identically to the default", async () => {
		await seedClonePair(repo);
		const output = await render({});
		const defgt = await auditWorkspace(repo, { now: PINNED });
		expectPlain(output);
		expect(output).not.toContain(SECTION_TITLE);
		// Same measurement ⇒ same rendering (only run metadata is excluded).
		expect(measurementPayload(await audit({}))).toEqual(measurementPayload(defgt));
		expect(withoutRunLine(output)).toBe(withoutRunLine(renderAuditTerminal(defgt)));
	});
});

describe("renderAuditTerminal with a complete provider analysis", () => {
	test.skipIf(!TOOL_AVAILABLE)(
		"explains state, provenance, asserted coverage, clone units and bounded findings",
		async () => {
			await seedClonePair(repo);
			const output = await render({ jscpd: { mode: "exact" } });
			expectPlain(output);
			expect(output).toContain(SECTION_TITLE);
			expect(output).toContain(
				"evidence: complete — every carried analysis ran over its full selection",
			);
			expect(output).toMatch(/jscpd +complete +mode exact · tool 5\.2\.1 · adapter 0\.1\.0/);
			// Asserted coverage — never inferred from the exit status.
			expect(output).toContain("coverage: analyzed 2 of 2 selected files (production 2)");
			// Pairs and groups are distinct units, never interchangeable with native groups.
			expect(output).toContain(
				"clone evidence: 1 pair (exact: 1 · normalized: 0 · near: 0) · 0 groups — " +
					"provider pairs and native clone groups are distinct units, never summed",
			);
			expect(output).toContain(
				"match modes: exact = identical text · normalized = renamed identifiers · " +
					"near = similar text (pair-only, never grouped)",
			);
			expect(output).toContain("provider.jscpd.duplication.clone-pairs = 1");
			expect(output).toContain("provider findings (1 of 1)");
			expect(output).toMatch(
				/provider\.jscpd\.clone-pair +src\/clone-a\.ts:1-13 · jscpd exact clone pair/,
			);
			expect(output).toContain(
				"full evidence: the JSON report (--json) carries every analysis's selection, " +
					"clone members, diagnostics and metrics",
			);
			// A complete advisory analysis never labels the native score partial.
			expect(headline(output)).not.toContain("PARTIAL");
			expect(output).toContain("completeness: complete");
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"bounds provider findings while always printing the total, in the carried order",
		async () => {
			await seedClonePair(repo);
			await putFile(repo, "src/clone-c.ts", CLONE_RENAMED);
			await putFile(repo, "src/clone-d.ts", CLONE_RENAMED);
			const full = await render({ jscpd: { mode: "exact" } });
			expect(full).toContain("provider findings (2 of 2)");
			const bounded = renderAuditTerminal(await audit({ jscpd: { mode: "exact" } }), {
				providerFindingLimit: 1,
			});
			expect(bounded).toContain("provider findings (1 of 2)");
			const rows = bounded
				.split("\n")
				.filter((line) => line.trimStart().startsWith("provider.jscpd.clone-"));
			expect(rows).toHaveLength(1);
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"states a completed analysis with zero findings explicitly, never as silence",
		async () => {
			await putFile(
				repo,
				"package.json",
				JSON.stringify({ name: "fixture-terminal-providers", version: "1.0.0" }),
			);
			// One above-threshold file: nothing to clone against, but complete coverage.
			await putFile(repo, "src/only.ts", CLONE_FN);
			const output = await render({ jscpd: { mode: "exact" } });
			expectPlain(output);
			expect(output).toMatch(/jscpd +complete/);
			expect(output).toContain(
				"clone evidence: 0 pairs (exact: 0 · normalized: 0 · near: 0) · 0 groups",
			);
			expect(output).toContain("findings: none — the analysis completed and found none");
			expect(output).toContain("evidence: complete");
		},
	);
});

describe("renderAuditTerminal with missing or partial provider evidence", () => {
	test.skipIf(!TOOL_AVAILABLE)(
		"renders mixed complete, incomplete and unsupported analyses without labelling the score partial",
		async () => {
			await seedClonePair(repo);
			await putFile(repo, "src/tiny.ts", "export const tiny = 1;\n");
			const output = await render({ jscpd: { mode: "exact" }, sonarjs: {} });
			expectPlain(output);
			expect(output).toContain("evidence: incomplete");
			// The incomplete analysis keeps its located reason and its partial
			// evidence — never a clean zero.
			expect(output).toMatch(/jscpd +incomplete +mode exact/);
			expect(output).toMatch(/reason: .*omitted from jscpd's source statistics/);
			expect(output).toContain("coverage: analyzed 0 of 3 selected files");
			expect(output).toContain("clone evidence: 1 pair (exact: 1 · normalized: 0 · near: 0)");
			expect(output).toContain("provider findings (1 of 1)");
			// The deferred provider is explained as deferred, never as absent.
			expect(output).toMatch(/sonarjs +unsupported +mode capability-request/);
			expect(output).toMatch(/reason: .*deferred by docs\/sonarjs-decision\.md/);
			// Overall evidence incompleteness is visible, and the native score —
			// complete — is never labelled partial by an advisory failure.
			expect(headline(output)).not.toContain("PARTIAL");
			expect(output).toContain("completeness: complete");
		},
	);

	test("renders requested undelivered providers as located unsupported evidence, never a clean zero", async () => {
		await seedClonePair(repo);
		// knip and sonarjs are the undelivered/gated set; dependency-cruiser
		// delivered its adapter (trellis-adbf) and now runs per request.
		const output = await render({ knip: {}, sonarjs: {} });
		expectPlain(output);
		expect(output).toContain(SECTION_TITLE);
		expect(output).toContain("evidence: incomplete");
		const first = output.indexOf("knip");
		const second = output.indexOf("sonarjs");
		expect(first).toBeGreaterThan(-1);
		expect(first).toBeLessThan(second);
		for (const id of ["knip", "sonarjs"]) {
			expect(output).toMatch(new RegExp(`${id} +unsupported +mode capability-request`));
			expect(output).toMatch(/reason: /);
		}
		expect(output).toMatch(/reason: .*LGPL-3\.0-only/);
		expect(headline(output)).not.toContain("PARTIAL");
	});

	test("renders a provider that cannot run over an empty selection as unsupported with its reason", async () => {
		await putFile(repo, "README.md", "no typescript here\n");
		const output = await render({ jscpd: { mode: "near" } });
		expectPlain(output);
		expect(output).toMatch(/jscpd +unsupported +mode near/);
		expect(output).toMatch(/reason: .*measured production\/test selection is empty/);
		expect(output).toContain("evidence: incomplete");
		expect(headline(output)).not.toContain("PARTIAL");
	});

	test("renders the missing evidence a required-but-unsupported provider leaves, without touching the score", async () => {
		await seedClonePair(repo);
		const required = { sonarjs: {} as const };
		const output = await render(required, {
			budgets: {},
			failOnNew: [],
			requireEvidence: ["sonarjs"],
		});
		expectPlain(output);
		expect(output).toMatch(/sonarjs +unsupported/);
		expect(output).toMatch(/reason: .*deferred by docs\/sonarjs-decision\.md/);
		expect(output).toContain("evidence: incomplete");
		// The requirement is policy, not measurement: the report it gates is
		// the same one rendered above (the policy exit code is assessed elsewhere).
		expect(
			measurementPayload(
				await audit(required, {
					budgets: {},
					failOnNew: [],
					requireEvidence: ["sonarjs"],
				}),
			),
		).toEqual(measurementPayload(await audit(required)));
		expect(headline(output)).not.toContain("PARTIAL");
	});

	test("renders an unrequested provider entry as not requested, distinct from a completed zero", async () => {
		await seedClonePair(repo);
		const report = await audit({ sonarjs: {} });
		// A contract-valid `unrequested` external entry — the core does not emit
		// one today, so it is appended additively and re-validated.
		const unrequested: ReportAnalysis = {
			provider: {
				kind: "external",
				id: "zzz",
				toolVersion: "0.0.0",
				adapterVersion: "0.0.0",
				mode: "capability-request",
				options: {},
			},
			state: "unrequested",
			scoring: "advisory",
			metricIds: [],
		};
		if (report.schemaVersion !== "1.1.0") throw new Error("expected an evidence-carrying report");
		const carried: AuditReport = {
			...report,
			evidence: { ...report.evidence, analyses: [...report.evidence.analyses, unrequested] },
		};
		expect(auditReportSchema.parse(carried)).toEqual(carried);
		const output = renderAuditTerminal(carried);
		expectPlain(output);
		expect(output).toMatch(/zzz +not requested +mode capability-request/);
		expect(output).toContain(
			"not requested — no analysis ran and no evidence exists " +
				"(a completed analysis that found nothing is a different, positive result)",
		);
		// An unrequested analysis never degrades the evidence (§16.2): the
		// unsupported sonarjs entry still does.
		expect(output).toContain("evidence: incomplete");
	});
});
