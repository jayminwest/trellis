/**
 * Deterministic measurement payload (SPEC §3.5) — the report minus its run
 * metadata. Same files + same configuration + same analyzer/scoring versions
 * ⇒ equal measurement payload. Timestamps and durations (`run`) are recorded
 * for operators but never participate in identity: {@link measurementPayload}
 * strips them, and {@link fingerprintPayload} hashes the canonical form, so
 * two runs of the same tree compare equal and fingerprint equal regardless of
 * when or how fast they ran.
 */
import { createHash } from "node:crypto";
import type { AuditReport } from "./report.ts";

/** The deterministic part of an {@link AuditReport} (SPEC §3.5). */
export type MeasurementPayload = Omit<AuditReport, "run">;

/** Strip non-deterministic run metadata from a report. */
export function measurementPayload(report: AuditReport): MeasurementPayload {
	const payload = { ...report };
	delete payload.run;
	return payload;
}

/**
 * Canonical JSON: object keys sorted recursively, `undefined` entries
 * dropped, array order preserved (producers order findings deterministically,
 * SPEC §3.2). Two payloads with equal content serialize byte-identically
 * regardless of key insertion order.
 */
export function canonicalStringify(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(canonicalize);
	}
	if (value !== null && typeof value === "object") {
		const sorted = Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, entry]) => [key, canonicalize(entry)] as const);
		return Object.fromEntries(sorted);
	}
	return value;
}

/** SHA-256 fingerprint of a payload's canonical form (SPEC §3.5). */
export function fingerprintPayload(payload: MeasurementPayload): string {
	return createHash("sha256").update(canonicalStringify(payload)).digest("hex");
}
