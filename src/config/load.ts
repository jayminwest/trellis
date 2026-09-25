/**
 * Audit configuration loading (SPEC §6.5) — reads the optional declarative
 * `trellis.yaml` at the repo root and validates it against the §6.5 contract
 * (`auditConfigSchema`). A missing file yields the documented defaults; an
 * invalid file is an operational error naming the offending keys. The file is
 * pure data — no executable hooks, no scoring-weight overrides.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type AuditConfig, auditConfigSchema } from "../contract/index.ts";
import { parseYaml } from "../contract/yaml.ts";

/** Candidate config filenames at the repo root, in priority order. */
export const CONFIG_FILENAMES = ["trellis.yaml", "trellis.yml"] as const;

/** Parse + validate one config document, naming its source file in any error. */
function parseConfig(text: string, name: string): AuditConfig {
	const data: unknown = parseYaml(text) ?? {};
	const parsed = auditConfigSchema.safeParse(data);
	if (!parsed.success) {
		const details = parsed.error.issues
			.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
			.join("; ");
		throw new Error(`invalid ${name}: ${details}`);
	}
	return parsed.data;
}

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
		return parseConfig(text, name);
	}
	return auditConfigSchema.parse({});
}

/**
 * Load and validate an explicit configuration file (the `--config <file>`
 * surface, SPEC §12). Unlike {@link loadAuditConfig} the file must exist and
 * be readable — the operator named it, so an absent file is an operational
 * error, never the defaults.
 */
export async function loadAuditConfigFile(path: string): Promise<AuditConfig> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (cause) {
		throw new Error(
			`cannot read config file ${path} (${cause instanceof Error ? cause.message : String(cause)})`,
		);
	}
	return parseConfig(text, path);
}
