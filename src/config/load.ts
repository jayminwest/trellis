/**
 * Audit configuration loading (SPEC §6.5) — read a `trellis.yaml` and
 * validate it against {@link auditConfigSchema}. Loading is offline and
 * safe: the YAML parser runs in js-yaml's default safe mode (no custom
 * types, no code construction), matching the contract's no-executable-hooks
 * rule. An empty or document-less file yields the all-defaults
 * configuration.
 */
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { ZodError } from "zod";
import { type AuditConfig, auditConfigSchema } from "./schema.ts";

/** A configuration file that failed to load or validate. */
export class ConfigError extends Error {
	override readonly name = "ConfigError";
	readonly file: string;

	constructor(message: string, file: string, options?: { cause: unknown }) {
		super(`${file}: ${message}`, options);
		this.file = file;
	}
}

/**
 * Load and validate the audit configuration at `path`. Throws
 * {@link ConfigError} on unreadable files, malformed YAML, non-mapping
 * documents, and schema violations.
 */
export function loadAuditConfig(path: string): AuditConfig {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		throw new ConfigError(`cannot read configuration (${(error as Error).message})`, path, {
			cause: error,
		});
	}
	let data: unknown;
	try {
		data = yaml.load(text);
	} catch (error) {
		throw new ConfigError(`malformed YAML (${(error as Error).message})`, path, {
			cause: error,
		});
	}
	if (data === undefined || data === null) {
		return auditConfigSchema.parse({});
	}
	if (typeof data !== "object" || Array.isArray(data)) {
		throw new ConfigError("configuration must be a YAML mapping", path);
	}
	try {
		return auditConfigSchema.parse(data);
	} catch (error) {
		if (error instanceof ZodError) {
			throw new ConfigError(`invalid configuration (${error.message})`, path, {
				cause: error,
			});
		}
		throw error;
	}
}
