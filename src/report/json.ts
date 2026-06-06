/**
 * JSON renderer (SPEC §6.3) — the exact §6.3 document, pretty-printed. This is
 * the machine contract and the determinism anchor: `JSON.stringify` emits object
 * keys in insertion order, and {@link auditRepo} builds `criteria` (and the app
 * map) in a fixed order, so two audits of the same checkout — with the same
 * `scoredAt` — serialize byte-for-byte identically.
 */
import type { Report } from "./types.ts";

/** Render a report as the canonical, 2-space-indented §6.3 JSON document. */
export function renderJson(report: Report): string {
	return JSON.stringify(report, null, 2);
}
