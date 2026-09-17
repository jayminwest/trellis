/**
 * Scored-basis selection over stored `audit_runs` rows (SPEC §3.5, §10,
 * §16.6 — plan `pl-43c5` step 8, trellis-ab01).
 *
 * History selection never re-derives its own comparability rule: a stored
 * run joins a trend series — or serves as the resolved baseline — exactly
 * when the step-6 **scored-basis** verdict (`assessScoredBasis`,
 * `src/compare/compatibility.ts`) says its scored basis is comparable with
 * the reference report's. Reusing that one verdict gives the §16.6 trend
 * rules by construction:
 *
 * - an advisory-only provider change (added, removed, upgraded, or
 *   reconfigured optional provider) never fragments a compatible native
 *   score series — advisory evidence is not part of the scored basis;
 * - a changed scored measurement or scoring basis starts a distinct,
 *   clearly marked series instead of a false trend — the run reads as
 *   incompatible and is excluded, never silently trended;
 * - a changed source revision is ordinary trend data — the `schema-span`,
 *   `source-scope-changed`, and `configuration-unverifiable` caveats never
 *   exclude a run.
 *
 * Selection reads the **stored JSON provenance** (the full §6.4 report in
 * `report_json`), not just the row's version columns: the scored metric
 * catalog, the declared scored analyses, and their recorded producer
 * semantics live only there. Rows are re-validated at this boundary
 * because the table is shared storage another writer may have touched — a
 * row that does not decode to a report this trellis reads is skipped, never
 * silently treated as external-measurement-compatible (a foreign schema
 * version, corrupt JSON, or a hand-written row all read as "no run").
 */
import { assessScoredBasis } from "../compare/compatibility.ts";
import { type AuditReport, auditReportSchema } from "../contract/index.ts";
import type { StoredAuditRun } from "./audit-store.ts";

/**
 * Decode a stored run's `report_json` into the §6.4 report it was rendered
 * from, or `null` when the row is not a report this trellis can interpret.
 *
 * Unlike {@link storedAuditReport} — the trusted round-trip for rows trellis
 * wrote itself — this is the defensive read history selection goes through:
 * the `audit_runs` table is shared storage, and a foreign or corrupt row
 * must read as absent, never crash a history query or imply compatibility
 * ("unknown provenance cannot silently imply external measurement
 * compatibility", plan risk 5).
 */
export function decodedStoredReport(run: StoredAuditRun): AuditReport | null {
	let raw: unknown;
	try {
		raw = JSON.parse(run.reportJson);
	} catch {
		return null;
	}
	const parsed = auditReportSchema.safeParse(raw);
	return parsed.success ? parsed.data : null;
}

/**
 * Whether a stored run's scored basis is comparable with the reference
 * report — the step-6 verdict, reused, never re-derived here: the run may
 * join the reference's trend series or serve as its resolved baseline. Only
 * a hard scored-basis incompatibility excludes a run (caveats never do),
 * and an undecodable row is never compatible.
 */
export function scoredBasisCompatible(run: StoredAuditRun, reference: AuditReport): boolean {
	const report = decodedStoredReport(run);
	if (report === null) return false;
	// The stored run is the earlier side (the baseline); the reference is
	// the later side (the new audit or the series anchor).
	return assessScoredBasis(report, reference).comparable;
}
