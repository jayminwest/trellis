import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { auditWorkspace } from "../../audit/audit.ts";
import {
	carriedProviderIds,
	evidenceArea,
	PINNED,
	providerAuditConfig,
	providerEntry,
	seedClonePair,
	stagedScratchCount,
} from "../../audit/provider-fixtures.ts";
import { auditReportSchema } from "../../contract/index.ts";
import { providerCapabilityStatus } from "../capabilities.ts";
import { PINNED_TOOLS, pinnedTool } from "../manifest.ts";

/**
 * The deferred sonarjs capability route (SPEC §16.7, plan `pl-43c5` step 26
 * — `trellis-7b99`; decision `docs/sonarjs-decision.md`, `trellis-db3e`).
 *
 * The recorded distribution and metric-interface decision is **DEFERRED**, so
 * this directory ships no adapter: these tests pin the deferred route the
 * merged capability table, execution plan and policy already expose —
 * requesting `sonarjs` is valid configuration that resolves to located
 * `unsupported` evidence with the recorded reason, the full native result is
 * preserved byte-for-byte, nothing is staged or launched, and no executable
 * Sonar route ships while the deferral stands. Enablement requires a new
 * versioned change carrying the cleared-route tests (acceptance 5); the
 * clearance prerequisite is tracked as `trellis-7f5d`.
 *
 * The policy side of the same route — a declarative `requireEvidence` on
 * `sonarjs` fails closed (the CLI's exit `2`) while the report is still
 * emitted — is pinned end-to-end in `src/audit/provider-policy.test.ts` and
 * at the core in `src/compare/policy-evidence.test.ts`; the capability
 * metadata shape is pinned in `../capabilities.test.ts`.
 */

const PACKAGE_JSON = resolve(import.meta.dir, "../../../package.json");

let repo: string;

beforeEach(async () => {
	repo = await mkdtemp(join(tmpdir(), "trellis-sonar-deferred-"));
	await seedClonePair(repo);
});

afterEach(async () => {
	await rm(repo, { recursive: true, force: true });
});

describe("sonarjs deferred capability", () => {
	test("resolves an explicit request to located unsupported evidence with the recorded decision", async () => {
		const report = await auditWorkspace(repo, {
			config: providerAuditConfig({ sonarjs: {} }),
			now: PINNED,
		});
		expect(auditReportSchema.parse(report)).toEqual(report);
		const entry = providerEntry(report, "sonarjs");
		// Located, truthful, policy-testable — never a fabricated clean result.
		expect(entry.state).toBe("unsupported");
		expect(entry.scoring).toBe("advisory");
		expect(entry.metricIds).toEqual([]);
		expect(entry.provider).toEqual({
			kind: "external",
			id: "sonarjs",
			toolVersion: "0.0.0",
			adapterVersion: "0.0.0",
			mode: "capability-request",
			options: {},
		});
		// The recorded reason cites the decision record, the deciding issue and
		// the clearance prerequisite (docs/sonarjs-decision.md, trellis-7f5d).
		expect(entry.reason).toContain("LGPL-3.0-only");
		expect(entry.reason).toContain("Source-Available License v1.0");
		expect(entry.reason).toContain("docs/sonarjs-decision.md");
		expect(entry.reason).toContain("trellis-db3e");
		expect(entry.reason).toContain("trellis-7f5d");
		// No analysis ran, so no measured output and no coverage are invented.
		expect(entry.analysis).toBeUndefined();
		expect(entry.observedCoverage).toBeUndefined();
		expect(entry.metrics).toBeUndefined();
		expect(entry.findings).toBeUndefined();
		expect(entry.cloneEvidence).toBeUndefined();
	});

	test("keeps the full native result while the evidence gap stays visible", async () => {
		const native = await auditWorkspace(repo, { now: PINNED });
		const enriched = await auditWorkspace(repo, {
			config: providerAuditConfig({ sonarjs: {} }),
			now: PINNED,
		});
		// Native measurement, score, findings and score completeness are
		// untouched (§16.5): the deferred request adds evidence, changes nothing.
		expect(enriched.score).toEqual(native.score);
		expect(enriched.metrics).toEqual(native.metrics);
		expect(enriched.findings).toEqual(native.findings);
		expect(enriched.completeness).toBe("complete");
		expect(enriched.score.partial).toBe(false);
		// All four native analyses still ride along, beside the sonarjs
		// entry (evidence entries are unique and ordered by provider id).
		expect(carriedProviderIds(enriched)).toEqual(["sonarjs", ...carriedProviderIds(native)]);
		// Evidence completeness degrades honestly (§16.2): an unsupported
		// analysis is a gap, but never a partial score.
		expect(evidenceArea(enriched).completeness).toBe("incomplete");
		expect(evidenceArea(native).completeness).toBe("complete");
	});

	test("stages nothing and launches nothing for a deferred request", async () => {
		const before = await stagedScratchCount();
		await auditWorkspace(repo, {
			config: providerAuditConfig({ sonarjs: {} }),
			now: PINNED,
		});
		expect(await stagedScratchCount()).toBe(before);
	});

	test("ships no executable sonarjs route while the deferral stands", async () => {
		// The capability table records the deferral, not an adapter.
		const status = providerCapabilityStatus("sonarjs");
		expect(status?.status).toBe("deferred");
		expect(status?.requestState).toBe("unsupported");
		// No pinned tool exists to resolve and no manifest entry claims one.
		expect(pinnedTool("sonarjs")).toBeUndefined();
		expect(PINNED_TOOLS.map((tool) => tool.providerId)).toEqual([
			"jscpd",
			"dependency-cruiser",
			"knip",
		]);
		// No Sonar dependency ships in this repository (no unapproved
		// redistribution — docs/sonarjs-decision.md, prerequisite trellis-7f5d).
		const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};
		for (const section of [pkg.dependencies, pkg.devDependencies]) {
			for (const name of Object.keys(section ?? {})) {
				expect(name.toLowerCase()).not.toContain("sonar");
			}
		}
	});
});
