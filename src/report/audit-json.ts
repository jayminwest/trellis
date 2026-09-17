/**
 * JSON renderer for the §6.4 metric report (SPEC §12, trellis-a059) — the
 * full structured document and the machine contract. The report is
 * re-validated against `auditReportSchema` at this boundary (renderers also
 * serve saved artifacts loaded from disk, trellis-942c), so a report that
 * violates the §6.4 cross-field honesty invariants fails here instead of
 * being published. `JSON.stringify` emits keys in schema order, so two
 * renders of the same report serialize byte-for-byte identically — the
 * determinism anchor for baseline comparison (§9).
 */
import { type AuditReport, auditReportSchema } from "../contract/index.ts";

/** Render a §6.4 audit report as the canonical, 2-space-indented JSON document. */
export function renderAuditJson(report: AuditReport): string {
	return JSON.stringify(auditReportSchema.parse(report), null, 2);
}
