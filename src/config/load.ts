/**
 * Audit configuration loading (SPEC §6.5) — reads the optional declarative
 * `trellis.yaml` at the repo root and validates it against the §6.5 contract
 * (`auditConfigSchema`). A missing file yields the documented defaults; an
 * invalid file is an operational error naming the offending keys. The file is
 * pure data — no executable hooks, no scoring-weight overrides.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import { type AuditConfig, auditConfigSchema } from "../contract/index.ts";

/** Candidate config filenames at the repo root, in priority order. */
export const CONFIG_FILENAMES = ["trellis.yaml", "trellis.yml"] as const;

/**
 * Load and validate the audit configuration for `root`. Returns the parsed
 * defaults when no config file exists; throws an `Error` describing every
 * schema violation when the file exists but is invalid.
 */
export async function loadAuditConfig(root: string): Promise<AuditConfig> {
	for (const name of CONFIG_FILENAMES) {
		let text: string;
		try {
			text = await readFile(join(root, name), "utf8");
		} catch {
			continue; // absent or unreadable → try the next candidate
		}
		const data: unknown = yaml.load(text) ?? {};
		const parsed = auditConfigSchema.safeParse(data);
		if (!parsed.success) {
			const details = parsed.error.issues
				.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
				.join("; ");
			throw new Error(`invalid ${name}: ${details}`);
		}
		return parsed.data;
	}
	return auditConfigSchema.parse({});
}
