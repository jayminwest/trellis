/**
 * Saved report artifacts (SPEC §9, trellis-942c) — read a previously emitted
 * JSON report from disk and re-validate it against the §6.4 contract. This is
 * the only I/O in `src/compare/`; comparison (`compare.ts`) and policy
 * assessment (`policy.ts`) are pure functions over the loaded artifacts.
 *
 * No Git, no SQLite: the artifact is a plain JSON document, exactly what the
 * JSON renderer (`src/report/audit-json.ts`) emits.
 *
 * Every failure here is an **operational** error (SPEC §9 exit-code
 * distinction): the artifact could not be read or is not a valid §6.4 report,
 * so the comparison could not run — never a policy failure. Callers map
 * {@link ReportArtifactError} to the operational exit (`1`), while a tripped
 * policy from `assessPolicy` maps to `2`.
 */
import { readFile } from "node:fs/promises";
import { type AuditReport, auditReportSchema } from "../contract/index.ts";

/** An operational failure to load a saved report artifact. */
export class ReportArtifactError extends Error {
	override readonly name = "ReportArtifactError";
	/** The artifact path that failed to load. */
	readonly path: string;

	constructor(path: string, message: string) {
		super(`${path}: ${message}`);
		this.path = path;
	}
}

/**
 * Load and validate a saved JSON report artifact. Throws
 * {@link ReportArtifactError} when the file is unreadable, is not JSON, or
 * violates the §6.4 contract (including its cross-field honesty invariants).
 */
export async function loadReportArtifact(path: string): Promise<AuditReport> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (cause) {
		throw new ReportArtifactError(
			path,
			`cannot read report artifact (${cause instanceof Error ? cause.message : String(cause)})`,
		);
	}
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch (cause) {
		throw new ReportArtifactError(
			path,
			`not a JSON document (${cause instanceof Error ? cause.message : String(cause)})`,
		);
	}
	const parsed = auditReportSchema.safeParse(data);
	if (!parsed.success) {
		const details = parsed.error.issues
			.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
			.join("; ");
		throw new ReportArtifactError(path, `invalid audit report: ${details}`);
	}
	return parsed.data;
}
