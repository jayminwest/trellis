/**
 * `targets.yaml` loader (SPEC §11) — the single declaration of the fleet.
 *
 * Post-pivot (trellis-8366), a target is a workspace the **deterministic core**
 * audits: `id` + `path`, an optional explicit `config` pointing at that repo's
 * `trellis.yaml` (when absent, the audit discovers it at the target root), and
 * the optional `canonical` block that feeds the **separate** standards-drift
 * capability (SPEC §11 — drift never enters the sloppiness index). `defaults`
 * carries the fleet-wide canonical version.
 *
 * Legacy readiness configuration is rejected with **actionable migration
 * errors**, never silently ignored (SPEC §11):
 *
 * - `defaults.investigation` — the agent investigation pass is gone (SPEC §14);
 * - `targets[].skip` — readiness criterion skips went away with the rubric;
 *   failure policy is now the declarative `policy` block of `trellis.yaml`;
 * - `targets[].languages` — the per-language detector hints went away with the
 *   rubric; the deterministic audit measures TypeScript/TSX source.
 *
 * Loading is zod-validated and strict (unknown keys are rejected so a typo fails
 * loudly rather than silently no-op'ing). Target ids must be unique — they label
 * the aggregate report. Every target `path` (and `config`) is resolved relative
 * to the `targets.yaml` location, so a fleet file is portable regardless of
 * where `trellis fleet` is invoked from. The loader does **not** touch the
 * target filesystem: a missing/unreadable path is the orchestrator's per-target
 * failure (`orchestrate.ts`), not a load-time abort of the whole fleet.
 *
 * {@link targetDriftOptions} is the fleet→standards seam: it maps a resolved
 * target (+ fleet defaults) onto the {@link DriftOptions} the canonical-drift
 * capability consumes — plumbing the resolved canonical version and the repo's
 * allowed deltas through without the orchestrator reaching into target
 * internals.
 */
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import { legacyConfigMessage, retiredReadinessMessage } from "../legacy.ts";
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

/**
 * One fleet target (SPEC §11). `path` (and `config`) resolve relative to the
 * `targets.yaml`. The retired readiness keys `skip` / `languages` are accepted
 * by the schema only so {@link loadFleet} can reject them with actionable
 * migration messages instead of a bare "unrecognized key" — they have no
 * effect otherwise.
 */
const targetSchema = z.strictObject({
	id: z.string().min(1),
	path: z.string().min(1),
	config: z.string().min(1).optional(),
	canonical: canonicalSchema.optional(),
	skip: z.unknown().optional(),
	languages: z.unknown().optional(),
});

/**
 * Fleet-wide defaults (SPEC §11): the canonical version. `investigation` is
 * accepted by the schema only so {@link loadFleet} can reject it with an
 * actionable retirement message (SPEC §14) instead of a bare "unrecognized
 * key" — it has no effect otherwise.
 */
const defaultsSchema = z.strictObject({
	canonicalVersion: semver.optional(),
	investigation: z.unknown().optional(),
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
 * Reject retired readiness/investigation keys with actionable migration
 * messages (SPEC §11) — the schema accepted them only so this guard can name
 * what to remove and what replaced it.
 */
function rejectRetiredKeys(data: TargetsFile): void {
	if (data.defaults?.investigation !== undefined) {
		throw new TargetsError(legacyConfigMessage("defaults.investigation"), "defaults.investigation");
	}
	for (const target of data.targets) {
		if (target.skip !== undefined) {
			throw new TargetsError(retiredReadinessMessage(`target '${target.id}'.skip`), target.id);
		}
		if (target.languages !== undefined) {
			throw new TargetsError(retiredReadinessMessage(`target '${target.id}'.languages`), target.id);
		}
	}
}

/**
 * Load, validate, and path-resolve the fleet from `file` (default
 * {@link TARGETS_FILE}). Throws {@link TargetsError} on an unreadable file, a
 * schema violation, a retired readiness/investigation key, or a duplicate
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
	rejectRetiredKeys(result.data);

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
