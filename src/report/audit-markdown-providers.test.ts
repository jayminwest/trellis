/**
 * Markdown rendering of the report's optional-provider evidence area (SPEC
 * §6.6, §16.2 — plan `pl-43c5` step 17, trellis-bba6).
 *
 * Mirrors `./audit-terminal-providers.test.ts` (step 16) so the two views
 * are proven to agree: every report is produced by the real deterministic
 * core over a real temp repository (`auditWorkspace` with a declarative
 * provider selection), the real-binary cases skip where the pinned jscpd
 * artifact is not installed, and the one contract-valid shape today's core
 * does not emit (`unrequested`) is appended additively and re-validated
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
	carriedAnalyses,
	type ReportAnalysis,
} from "../contract/index.ts";
import { renderAuditMarkdown } from "./audit-markdown.ts";
import { PROVIDER_SECTION_TITLE } from "./audit-markdown-providers.ts";

/** Clone-fragment identifier variants: each yields a distinct exact-matched fragment. */
const CLONE_VARIANTS = [
	"omega",
	"sigma",
	"tau",
	"rho",
	"beta",
	"gamma",
	"delta",
	"kappa",
	"lambda",
	"mu",
	"nu",
	"xi",
] as const;

/** The headline sloppiness line of a rendered report. */
function headline(output: string): string {
	const line = output.split("\n").find((candidate) => candidate.includes("sloppiness index"));
	if (line === undefined) throw new Error("rendered report has no score headline");
	return line;
}

let repo: string;

beforeEach(async () => {
	repo = await mkdtemp(join(tmpdir(), "trellis-markdown-providers-"));
});

afterEach(async () => {
	await rm(repo, { recursive: true, force: true });
});

/** Audit `repo` through the one core with the given provider selection. */
async function audit(providers: Parameters<typeof providerAuditConfig>[0]): Promise<AuditReport> {
	return auditWorkspace(repo, { config: providerAuditConfig(providers), now: PINNED });
}

/** The rendered Markdown report of `repo`'s audit. */
async function render(providers: Parameters<typeof providerAuditConfig>[0]): Promise<string> {
	return renderAuditMarkdown(await audit(providers));
}

describe("renderAuditMarkdown without optional providers", () => {
	test("renders a native-only audit with no provider section and no provider noise", async () => {
		await seedClonePair(repo);
		const output = renderAuditMarkdown(await auditWorkspace(repo, { now: PINNED }));
		expect(output).not.toContain(PROVIDER_SECTION_TITLE);
		expect(output).not.toContain("Provider analyses");
		expect(output).not.toMatch(/provider\.[a-z]/);
	});

	test("renders an empty providers block byte-identically to the default", async () => {
		await seedClonePair(repo);
		const output = await render({});
		const defgt = await auditWorkspace(repo, { now: PINNED });
		// Same measurement ⇒ same rendering; Markdown carries no run metadata.
		expect(output).toBe(renderAuditMarkdown(defgt));
	});

	test("renders a pre-provider (1.0.0) artifact with no provider section, never relabeled", async () => {
		await seedClonePair(repo);
		const report = await auditWorkspace(repo, { now: PINNED });
		const legacy = { ...report } as Record<string, unknown>;
		delete legacy.evidence;
		legacy.schemaVersion = "1.0.0";
		const loaded = auditReportSchema.parse(legacy);
		expect(carriedAnalyses(loaded)).toEqual([]);
		const output = renderAuditMarkdown(loaded);
		expect(output).not.toContain("Provider analyses");
		expect(output).toContain("## Safeguards");
	});
});

describe("renderAuditMarkdown with a complete provider analysis", () => {
	test.skipIf(!TOOL_AVAILABLE)(
		"separates advisory evidence from the score and explains state, provenance and coverage",
		async () => {
			await seedClonePair(repo);
			const output = await render({ jscpd: { mode: "exact" } });
			expect(output).toContain(`## ${PROVIDER_SECTION_TITLE}`);
			expect(output).toContain(
				"Evidence: complete — every carried analysis ran over its full selection.",
			);
			expect(output).toContain(
				"Evidence completeness is independent of score completeness; " +
					"advisory analyses never enter the sloppiness index or its contributions (SPEC §16.5).",
			);
			expect(output).toContain("### jscpd — complete");
			expect(output).toContain("- provenance: mode exact · tool 5.2.1 · adapter 0.1.0");
			// Asserted coverage — never inferred from the exit status.
			expect(output).toContain("- coverage: analyzed 2 of 2 selected files (production 2)");
			// Pairs and groups are distinct units, never interchangeable with native groups.
			expect(output).toContain(
				"- clone evidence: 1 pair (exact: 1 · normalized: 0 · near: 0) · 0 groups — " +
					"provider pairs and native clone groups are distinct units, never summed",
			);
			expect(output).toContain(
				"- match modes: exact = identical text · normalized = renamed identifiers · " +
					"near = similar text (pair-only, never grouped)",
			);
			expect(output).toContain("provider.jscpd.duplication.clone-pairs = 1");
			// Evidence locations are usable relative paths.
			expect(output).toContain(
				"- provider findings (1 of 1):\n  - `provider.jscpd.clone-pair` src/clone-a.ts:1-13 — jscpd exact clone pair",
			);
			expect(output).toContain(
				"Full evidence: the JSON report carries every analysis's selection, " +
					"clone members, diagnostics and metrics.",
			);
			// A complete advisory analysis never labels the native score partial.
			expect(headline(output)).not.toContain("PARTIAL");
			expect(output).toContain("completeness: complete");
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"bounds a large finding set while always printing the total, in the carried order",
		async () => {
			await putFile(
				repo,
				"package.json",
				JSON.stringify({ name: "fixture-markdown-providers", version: "1.0.0" }),
			);
			// Twelve distinct clone fragments, each duplicated exactly once:
			// twelve exact pairs — more than the default bound of ten.
			for (const [index, variant] of CLONE_VARIANTS.entries()) {
				const source = CLONE_FN.replace(/alpha/g, variant);
				await putFile(repo, `src/clone-${index}-a.ts`, source);
				await putFile(repo, `src/clone-${index}-b.ts`, source);
			}
			const report = await audit({ jscpd: { mode: "exact" } });
			const output = renderAuditMarkdown(report);
			expect(output).toContain("- provider findings (10 of 12):");
			const bounded = renderAuditMarkdown(report, { providerFindingLimit: 3 });
			expect(bounded).toContain("- provider findings (3 of 12):");
			// Every shown row carries an evidence location.
			const rows = bounded.split("\n").filter((line) => line.startsWith("  - `provider."));
			expect(rows).toHaveLength(3);
			for (const row of rows) {
				expect(row).toMatch(/src\/clone-\d+-[ab]\.ts:\d+(-\d+)?/);
			}
			// Pair and group units stay distinct, never summed, at any bound — the
			// provider reports 11 pairs and 1 group beside the native detector's own
			// single 24-member clone group, and no renderer ever merges them.
			expect(output).toContain(
				"- clone evidence: 11 pairs (exact: 11 · normalized: 0 · near: 0) · 1 group — " +
					"provider pairs and native clone groups are distinct units, never summed",
			);
			expect(output).toContain(
				"| duplication.clone-group | src/clone-0-a.ts:1-13 | 24 copies of 105 normalized tokens |",
			);
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"states a completed analysis with zero findings explicitly, never as silence",
		async () => {
			await putFile(
				repo,
				"package.json",
				JSON.stringify({ name: "fixture-markdown-providers", version: "1.0.0" }),
			);
			// One above-threshold file: nothing to clone against, but complete coverage.
			await putFile(repo, "src/only.ts", CLONE_FN);
			const output = await render({ jscpd: { mode: "exact" } });
			expect(output).toContain("### jscpd — complete");
			expect(output).toContain(
				"- clone evidence: 0 pairs (exact: 0 · normalized: 0 · near: 0) · 0 groups",
			);
			expect(output).toContain("- findings: none — the analysis completed and found none");
			expect(output).toContain("Evidence: complete");
		},
	);

	test.skipIf(!TOOL_AVAILABLE)(
		"keeps the structural score native: contributions sum to the index and no percentage is fabricated",
		async () => {
			await seedClonePair(repo);
			const report = await audit({ jscpd: { mode: "exact" } });
			const output = renderAuditMarkdown(report);
			// The index is 0–100 lower-is-better — never a % of bad code (§3.4).
			expect(output).not.toMatch(/\d+%/);
			expect(headline(output)).not.toContain("PARTIAL");
			// Native score contributions still sum to the native score.
			const sum = report.score.contributions.reduce((total, c) => total + c.points, 0);
			expect(sum).toBeCloseTo(report.score.index, 6);
			// No provider metric or finding appears among the score contributions.
			for (const contribution of report.score.contributions) {
				for (const metricId of contribution.metricIds) {
					expect(metricId.startsWith("provider.")).toBe(false);
				}
			}
			// The advisory metrics live only in the provider section.
			expect(output).toContain("provider.jscpd.duplication.clone-pairs = 1");
			expect(output.indexOf("## Provider analyses")).toBeGreaterThan(
				output.indexOf("## Score contributions"),
			);
		},
	);
});

describe("renderAuditMarkdown with missing or partial provider evidence", () => {
	test.skipIf(!TOOL_AVAILABLE)(
		"renders mixed complete, incomplete and unsupported analyses without labelling the score partial",
		async () => {
			await seedClonePair(repo);
			await putFile(repo, "src/tiny.ts", "export const tiny = 1;\n");
			const output = await render({ jscpd: { mode: "exact" }, sonarjs: {} });
			expect(output).toContain("Evidence: incomplete");
			// The incomplete analysis keeps its located reason and its partial
			// evidence — never a clean zero.
			expect(output).toContain("### jscpd — incomplete");
			expect(output).toMatch(/- reason: .*omitted from jscpd's source statistics/);
			expect(output).toContain("- coverage: analyzed 0 of 3 selected files");
			expect(output).toContain("1 pair (exact: 1 · normalized: 0 · near: 0)");
			expect(output).toContain("- provider findings (1 of 1):");
			// The deferred provider is explained as deferred, never as absent.
			expect(output).toContain("### sonarjs — unsupported");
			expect(output).toMatch(/- reason: .*deferred by docs\/sonarjs-decision\.md/);
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
		expect(output).toContain(`## ${PROVIDER_SECTION_TITLE}`);
		expect(output).toContain("Evidence: incomplete");
		// Analyses render in the report's provider-id order.
		const first = output.indexOf("### knip");
		const second = output.indexOf("### sonarjs");
		expect(first).toBeGreaterThan(-1);
		expect(first).toBeLessThan(second);
		for (const id of ["knip", "sonarjs"]) {
			expect(output).toContain(`### ${id} — unsupported`);
			expect(output).toMatch(/- reason: /);
		}
		expect(output).toMatch(/- reason: .*LGPL-3\.0-only/);
		expect(headline(output)).not.toContain("PARTIAL");
	});

	test("renders a provider that cannot run over an empty selection as unsupported with its reason", async () => {
		await putFile(repo, "README.md", "no typescript here\n");
		const output = await render({ jscpd: { mode: "near" } });
		expect(output).toContain("### jscpd — unsupported");
		expect(output).toMatch(/- reason: .*measured production\/test selection is empty/);
		expect(output).toContain("Evidence: incomplete");
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
		const output = renderAuditMarkdown(carried);
		expect(output).toContain("### zzz — not requested");
		expect(output).toContain(
			"- not requested — no analysis ran and no evidence exists " +
				"(a completed analysis that found nothing is a different, positive result)",
		);
		// An unrequested analysis never degrades the evidence (§16.2): the
		// unsupported sonarjs entry still does.
		expect(output).toContain("Evidence: incomplete");
	});
});
