/**
 * `targets.yaml` loader (SPEC §6.5) — the single declaration of the fleet.
 *
 * Because trellis state is central (SPEC §2), the per-repo knobs that would
 * otherwise live in each audited repo live here instead: which canonical version
 * a repo compares against, the **allowed deltas** that whitelist its sanctioned
 * divergences, the criteria it forces not-applicable, and its language hint.
 * `defaults` carries the fleet-wide canonical version. Transitional (SPEC §14 stage 2): the retired
 * `defaults.investigation` provider/model keys are rejected with an actionable
 * error rather than silently ignored.
 *
 * Loading is zod-validated and strict (unknown keys are rejected so a typo fails
 * loudly rather than silently no-op'ing). Target ids must be unique — they key
 * the central run history. Every target `path` is resolved relative to the
 * `targets.yaml` location, so a fleet file is portable regardless of where
 * `trellis fleet` is invoked from. The loader does **not** touch the target
 * filesystem: a missing/unreadable path is the orchestrator's per-target failure
 * (`orchestrate.ts`), not a load-time abort of the whole fleet.
 *
 * {@link targetAuditOptions} is the WHAT→audit seam: it maps a resolved target
 * (+ fleet defaults) onto the surface-agnostic {@link AuditOptions} the core
 * audit consumes — plumbing `skip`, `allowedDeltas`, `languages`, and the
 * resolved canonical version through without the orchestrator reaching into
 * target internals.
 */
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import { LANGUAGES } from "../detectors/index.ts";
import { legacyConfigMessage } from "../legacy.ts";
import type { AuditOptions } from "../report/index.ts";
import type { AllowedDelta, DriftOptions } from "../standards/index.ts";

/** Default fleet declaration filename, relative to the invocation cwd. */
export const TARGETS_FILE = "targets.yaml";

/** Strict semver `MAJOR.MINOR.PATCH` — matches the canonical manifest's versioning. */
const semver = z.string().regex(/^\d+\.\d+\.\d+$/, "must be semver MAJOR.MINOR.PATCH");

/** One whitelisted divergence (SPEC §6.5 `canonical.allowedDeltas`); mirrors {@link AllowedDelta}. */
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

/** One fleet target (SPEC §6.5). `path` is resolved relative to the `targets.yaml`. */
const targetSchema = z.strictObject({
	id: z.string().min(1),
	path: z.string().min(1),
	languages: z.array(z.enum(LANGUAGES)).min(1).optional(),
	canonical: canonicalSchema.optional(),
	skip: z.array(z.string().min(1)).optional(),
});

/**
 * Fleet-wide defaults (SPEC §6.5): the canonical version. `investigation` is
 * accepted by the schema only so {@link loadFleet} can reject it with an
 * actionable retirement message (SPEC §14 stage 2) instead of a bare
 * "unrecognized key" — it has no effect otherwise.
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

/** A target with its `path` resolved to an absolute filesystem location. */
export interface ResolvedTarget {
	/** The validated declaration as written. */
	readonly spec: TargetSpec;
	/** Absolute path the audit runs against (relative entries resolved off the fleet file). */
	readonly absPath: string;
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
 * schema violation, or a duplicate target id. Target paths are resolved relative
 * to the fleet file's directory; the target filesystem is not touched here.
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

	if (result.data.defaults?.investigation !== undefined) {
		throw new TargetsError(legacyConfigMessage("defaults.investigation"), "defaults.investigation");
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
	}));
	return { defaults: result.data.defaults ?? {}, targets, baseDir };
}

/**
 * Map a resolved target (+ fleet defaults) onto the {@link AuditOptions} the core
 * audit consumes (SPEC §6.5). The fleet always runs canonical drift, so a
 * {@link DriftOptions} is always present, carrying the resolved canonical version
 * (per-repo override > fleet default > the bundled set) and the repo's allowed
 * deltas. `skip` and the language hint pass through only when the target sets
 * them.
 */
export function targetAuditOptions(target: ResolvedTarget, defaults: FleetDefaults): AuditOptions {
	const { spec } = target;
	const canonicalVersion = spec.canonical?.version ?? defaults.canonicalVersion;
	const allowedDeltas: readonly AllowedDelta[] | undefined = spec.canonical?.allowedDeltas;
	const canonical: DriftOptions = {
		repoId: spec.id,
		...(canonicalVersion === undefined ? {} : { canonicalVersion }),
		...(allowedDeltas === undefined ? {} : { allowedDeltas }),
	};
	return {
		repoId: spec.id,
		canonical,
		...(spec.languages === undefined ? {} : { languages: spec.languages }),
		...(spec.skip === undefined ? {} : { skip: spec.skip }),
	};
}
