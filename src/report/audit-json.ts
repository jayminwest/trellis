/**
 * JSON renderer for the versioned §6.4 report (SPEC §12, §16.6 —
 * trellis-a059, trellis-bba6) — the full structured document and the machine
 * contract. The renderer emits **exactly** the typed report
 * (`src/contract/report.ts`): schema `1.1.0` artifacts carry the per-analysis
 * evidence area (§6.6), schema `1.0.0` artifacts keep their original
 * pre-provider shape, and the output is the wire artifact `loadReportArtifact`
 * (`src/compare/load.ts`) reads back — never a renderer-local shape. A schema
 * version this trellis cannot read fails at the load boundary with the
 * supported versions named (§16.6).
 *
 * The report is re-validated against `auditReportSchema` at this boundary
 * (renderers also serve saved artifacts loaded from disk, trellis-942c), so a
 * report that violates the §6.4 cross-field honesty invariants — or a
 * malformed provider-evidence entry — fails here instead of being published.
 * `JSON.stringify` emits keys in schema order, so two renders of the same
 * report serialize byte-for-byte identically — the determinism anchor for
 * baseline comparison (§9).
 *
 * Stable versus volatile fields (SPEC §3.5): everything except `run` is
 * **stable** — the same sources, configuration and analyzer/scoring versions
 * always serialize identically, including the evidence area (analyses in
 * provider-id order, clone members in deterministic location order, options
 * with sorted keys; equivalent raw provider reports normalize to identical
 * evidence, `src/providers/jscpd/normalize.ts`). **Volatile** fields describe
 * one execution, never the measurement: `run.auditedAt` and `run.durationMs`,
 * plus an optional per-analysis `execution` block (timestamps, durations,
 * machine paths) recorded for operators and excluded from measurement
 * identity. Equality and fingerprinting use `measurementPayload`, which strips
 * the report-level `run` block.
 */
import { type AuditReport, auditReportSchema } from "../contract/index.ts";

/** Render a §6.4 audit report as the canonical, 2-space-indented JSON document. */
export function renderAuditJson(report: AuditReport): string {
	return JSON.stringify(auditReportSchema.parse(report), null, 2);
}
