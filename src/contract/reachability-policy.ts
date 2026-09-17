/**
 * Declarative reachability-context contract (SPEC §16.1/§16.4 — plan
 * `pl-43c5` step 23, trellis-5da5).
 *
 * A bounded Knip request model: explicit application/script entries,
 * exported public surfaces and whether test files participate as
 * reachability roots — expressed as **data**, never an executable `knip`
 * config, never an entry guess. The declared model exists because local
 * non-use never means unnecessary code (plan risk 6): a reachability
 * analysis without declared roots can only produce *candidates* over an
 * undefined model, so the request records what the operator asserts and
 * the pure preparation (`src/providers/knip/`) records what that leaves
 * undefined as explicit contextual assumptions (AC3) — omitted entries
 * and missing dependency context can never imply confirmed dead code.
 *
 * Root categories (declared here; the adapter evaluates them — step 24,
 * trellis-8ebc):
 *
 * - `entries` — application/script entry files (a CLI main, a package
 *   index, a `scripts/` tool): production files where execution starts,
 *   hence reachability roots. A declared entry resolving to a *test* file
 *   is a legitimate explicit root that supplies reachability evidence
 *   while staying classified `test` (AC2: test files may participate
 *   without being scored as production or diluting production
 *   denominators).
 * - `public` — exported public surfaces: a file whose exports are public
 *   API, optionally narrowed to one named export (`{ path, export }`).
 *   A public surface is the **declared file itself** — a barrel's
 *   re-export is the barrel's surface, at the barrel's path; the
 *   implementation files it exposes are ordinary project files, and a
 *   candidate on the surface never names the implementation (AC5). The
 *   pure preparation never expands re-exports.
 * - `tests` — whether the measured test files participate as reachability
 *   roots (`roots`) or supply no evidence (`excluded`, the default,
 *   matching the research record where tests were not entry points).
 *   Participating test files stay in their own set — never production
 *   members, never in the production project-file denominator.
 *
 * **Absence is a recorded assumption, never a finding (AC3):** every key
 * is optional — an absent (or empty) `entries`/`public` declares no
 * reachability claims, and the compiled policy (`src/providers/knip/
 * policy.ts`) records the absence as visible, comparable identity plus
 * explicit assumptions. Nothing is guessed: no entry is inferred from
 * package manifests, framework conventions or directory names, and no
 * absence is read as clean code.
 *
 * **Plugin discovery is disabled (AC4):** the schema has no plugin keys at
 * all — Knip's framework/tool plugin registry is never enabled by
 * trellis, and a strict object rejects any attempted plugin vocabulary
 * actionably at config-load time (operational exit `1`, SPEC §16.3). The
 * compiled policy carries `pluginDiscovery: "disabled"` so the fact rides
 * the analysis identity; any future plugin support requires a separately
 * declared trust boundary, never arbitrary target configuration or
 * plugin code (SPEC §16.4).
 *
 * Rejections (config-load time, all actionable): unknown keys (the strict
 * object and the closed `tests` union — a pasted executable `knip` config
 * or a plugin flag cannot parse), duplicate entries, duplicate public
 * surfaces, and invalid declarations (absolute paths, `..` traversal,
 * backslashes, over-length paths, non-identifier export names, over-long
 * lists).
 */
import { z } from "zod";
import { isRepoRelativePath } from "./primitives.ts";

/**
 * The declarative subset's version — part of the normalized configuration
 * identity (`src/providers/knip/policy.ts`). Bumping it is a semantics
 * change: compiled identities then differ even for byte-identical
 * declarations, so evidence never silently continues across a changed
 * reachability vocabulary.
 */
export const REACHABILITY_POLICY_VERSION = 1;

/**
 * Declaration bounds: a declared reachability context is always finite and
 * cheap to evaluate. Entry files, public surfaces, path lengths and export
 * names are capped at parse time; the compiled policy records the bounds
 * it was validated under.
 */
export const MAX_REACHABILITY_ENTRY_FILES = 64;
export const MAX_REACHABILITY_PUBLIC_SURFACES = 64;
export const MAX_REACHABILITY_PATH_LENGTH = 256;
export const MAX_REACHABILITY_EXPORT_NAME_LENGTH = 64;

/**
 * Whether the measured test files participate as reachability roots
 * (AC1/AC2). `excluded` (the default) — test files supply no reachability
 * evidence, so production symbols used only by tests appear as candidates
 * without being dead. `roots` — every measured test file supplies
 * reachability evidence, recorded in its own test-root set: participation
 * never makes a test file a production member and never dilutes a
 * production denominator.
 */
export const REACHABILITY_TEST_MODES = ["excluded", "roots"] as const;
export type ReachabilityTestMode = (typeof REACHABILITY_TEST_MODES)[number];
export const reachabilityTestModeSchema = z.enum(REACHABILITY_TEST_MODES);

/**
 * A declared file path: repo-relative POSIX (`src/cli/main.ts`), bounded
 * in length. Absolute paths, Windows drive paths, backslashes, empty
 * segments and `..` traversal are rejected — a declaration can never
 * point outside the audited root.
 */
export const reachabilityPathSchema = z
	.string()
	.min(1)
	.max(MAX_REACHABILITY_PATH_LENGTH)
	.refine(isRepoRelativePath, "must be a repo-relative POSIX path");

/**
 * A named export on a public surface: a JavaScript identifier. A surface
 * without `export` declares the whole file's exports public.
 */
export const reachabilityExportNameSchema = z
	.string()
	.regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, "must be a JavaScript identifier")
	.max(MAX_REACHABILITY_EXPORT_NAME_LENGTH);

/**
 * One declared public surface (AC1/AC5): the file whose exports are public
 * API, optionally narrowed to one named export. The surface is the
 * declared file — a barrel re-export is a distinct surface from the
 * implementation it exposes, and the implementation is never implied
 * public or reachable by the declaration. Exactly the two keys; unknown
 * vocabulary is rejected, never reinterpreted.
 */
export const reachabilityPublicSurfaceSchema = z.strictObject({
	path: reachabilityPathSchema,
	export: reachabilityExportNameSchema.optional(),
});
export type ReachabilityPublicSurface = z.infer<typeof reachabilityPublicSurfaceSchema>;

/**
 * A Knip provider request: the declared reachability context, inline. Every
 * key is optional — an empty request `{}` is valid configuration that
 * declares no reachability claims (AC3), and an absent key is recorded as
 * an explicit contextual assumption by the compilation, never as a clean
 * result.
 *
 * Per-key duplicates are rejected here (config-load time): a repeated
 * entry or public surface is an ambiguous declaration, not silently
 * de-duplicated. A file may appear in both `entries` and `public` — an
 * execution entry can also be a public surface (a package index is both).
 */
export const knipProviderRequestSchema = z
	.strictObject({
		entries: z.array(reachabilityPathSchema).max(MAX_REACHABILITY_ENTRY_FILES).optional(),
		public: z
			.array(reachabilityPublicSurfaceSchema)
			.max(MAX_REACHABILITY_PUBLIC_SURFACES)
			.optional(),
		tests: reachabilityTestModeSchema.optional(),
	})
	.superRefine((request, ctx) => {
		const seenEntries = new Set<string>();
		for (const [index, path] of (request.entries ?? []).entries()) {
			if (seenEntries.has(path)) {
				ctx.addIssue({
					code: "custom",
					message: `entry "${path}" is declared twice — declare each entry file once`,
					path: ["entries", index],
				});
			} else {
				seenEntries.add(path);
			}
		}
		const surfaceKey = (surface: ReachabilityPublicSurface) =>
			surface.export === undefined ? surface.path : `${surface.path}#${surface.export}`;
		const seenSurfaces = new Set<string>();
		for (const [index, surface] of (request.public ?? []).entries()) {
			const key = surfaceKey(surface);
			if (seenSurfaces.has(key)) {
				ctx.addIssue({
					code: "custom",
					message: `public surface "${key}" is declared twice — declare each surface once`,
					path: ["public", index],
				});
			} else {
				seenSurfaces.add(key);
			}
		}
	});
export type KnipProviderRequest = z.infer<typeof knipProviderRequestSchema>;
