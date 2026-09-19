/** Strict declarative fleet configuration; paths resolve relative to targets.yaml. */
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import type { AllowedDelta, DriftOptions } from "../standards/index.ts";

/** Default fleet declaration filename, relative to the invocation cwd. */
export const TARGETS_FILE = "targets.yaml";

/** Strict semver `MAJOR.MINOR.PATCH` — matches the canonical manifest's versioning. */
const semver = z.string().regex(/^\d+\.\d+\.\d+$/, "must be semver MAJOR.MINOR.PATCH");

/** One whitelisted divergence (SPEC §11 `canonical.allowedDeltas`); mirrors {@link AllowedDelta}. */
const allowedDeltaSchema = z.strictObject({
	file: z.string().min(1),
	paths: z.array(z.string().min(1)).optional(),
	reason: z.string().min(1),
});

/** Per-repo canonical overrides: version pin + the sanctioned-divergence whitelist. */
const canonicalSchema = z.strictObject({
	version: semver.optional(),
	allowedDeltas: z.array(allowedDeltaSchema).optional(),
});

/** One fleet target; paths resolve relative to targets.yaml. */
const targetSchema = z.strictObject({
	id: z.string().min(1),
	path: z.string().min(1),
	config: z.string().min(1).optional(),
	canonical: canonicalSchema.optional(),
});

/** Fleet-wide canonical version. */
const defaultsSchema = z.strictObject({
	canonicalVersion: semver.optional(),
});

/** The full `targets.yaml` document. */
export const targetsSchema = z.strictObject({
	defaults: defaultsSchema.optional(),
	targets: z.array(targetSchema).min(1),
});

/** A validated target spec (pre path-resolution). */
export type TargetSpec = z.infer<typeof targetSchema>;
/** Validated fleet defaults. */
export type FleetDefaults = z.infer<typeof defaultsSchema>;
/** The validated `targets.yaml` document. */
export type TargetsFile = z.infer<typeof targetsSchema>;

/** A target with its `path` (and `config`) resolved to absolute filesystem locations. */
export interface ResolvedTarget {
	/** The validated declaration as written. */
	readonly spec: TargetSpec;
	/** Absolute path the audit runs against (relative entries resolved off the fleet file). */
	readonly absPath: string;
	/** Absolute path of the explicit `trellis.yaml`, when the target declares one. */
	readonly absConfigPath?: string;
}

/** A loaded, path-resolved fleet ready to orchestrate. */
export interface Fleet {
	readonly defaults: FleetDefaults;
	readonly targets: readonly ResolvedTarget[];
	/** Directory of the `targets.yaml`, the base for relative path resolution. */
	readonly baseDir: string;
}

/** A `targets.yaml` load/validation failure, naming the offending location. */
export class TargetsError extends Error {
	override readonly name = "TargetsError";
	readonly where: string;

	constructor(message: string, where = "") {
		super(where ? `${TARGETS_FILE} [${where}]: ${message}` : `${TARGETS_FILE}: ${message}`);
		this.where = where;
	}
}

/**
 * Load, validate, and path-resolve the fleet from `file` (default
 * {@link TARGETS_FILE}). Throws {@link TargetsError} on an unreadable file, a
 * schema violation or a duplicate
 * target id. Target paths are resolved relative to the fleet file's directory;
 * the target filesystem is not touched here.
 */
export function loadFleet(file: string = TARGETS_FILE): Fleet {
	const path = resolve(file);
	let raw: unknown;
	try {
		raw = yaml.load(readFileSync(path, "utf8"));
	} catch {
		throw new TargetsError("source file not found or unreadable");
	}

	const result = targetsSchema.safeParse(raw);
	if (!result.success) {
		const issue = result.error.issues[0];
		const where = issue?.path.join(".") || "<root>";
		throw new TargetsError(issue?.message ?? "schema validation failed", where);
	}

	const seen = new Set<string>();
	for (const target of result.data.targets) {
		if (seen.has(target.id)) throw new TargetsError("duplicate target id", target.id);
		seen.add(target.id);
	}

	const baseDir = dirname(path);
	const targets = result.data.targets.map((spec) => ({
		spec,
		absPath: isAbsolute(spec.path) ? resolve(spec.path) : resolve(baseDir, spec.path),
		...(spec.config === undefined
			? {}
			: {
					absConfigPath: isAbsolute(spec.config)
						? resolve(spec.config)
						: resolve(baseDir, spec.config),
				}),
	}));
	return { defaults: result.data.defaults ?? {}, targets, baseDir };
}

/**
 * Map a resolved target (+ fleet defaults) onto the {@link DriftOptions} the
 * canonical-drift capability consumes (SPEC §11): the target id as the drift
 * repo label, the resolved canonical version (per-repo override > fleet
 * default > the bundled set), and the repo's allowed deltas. Drift is a
 * separate capability — these options never reach the audit or its score.
 */
export function targetDriftOptions(target: ResolvedTarget, defaults: FleetDefaults): DriftOptions {
	const { spec } = target;
	const canonicalVersion = spec.canonical?.version ?? defaults.canonicalVersion;
	const allowedDeltas: readonly AllowedDelta[] | undefined = spec.canonical?.allowedDeltas;
	return {
		repoId: spec.id,
		...(canonicalVersion === undefined ? {} : { canonicalVersion }),
		...(allowedDeltas === undefined ? {} : { allowedDeltas }),
	};
}
