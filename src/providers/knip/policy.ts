/**
 * Pure reachability-policy compilation (plan `pl-43c5` step 23,
 * trellis-5da5) — the declarative Knip request of
 * `src/contract/reachability-policy.ts` compiled into one deterministic,
 * normalized reachability policy. No Knip invocation, no process, no I/O:
 * step 24 (trellis-8ebc) owns the adapter that turns the compiled context
 * into advisory evidence.
 *
 * The compiled policy is the **normalized configuration identity** (AC3):
 * entries and public surfaces in canonical order, a canonical serialization
 * and its sha-256 digest. The digest rides the analysis identity through
 * the step-6 conventions (`identityOptions` is a `ProviderOptions`
 * fragment the adapter merges into its `ProviderIdentity.options`, §16.2
 * `src/contract/analysis.ts`), so `producerSemanticsDifferences`
 * (`src/compare/evidence.ts` — the one seam `compatibility.ts` and the
 * evidence comparison both consume) treats a changed declared
 * reachability context as a changed measurement: noncomparable evidence,
 * never silently diffed into new/resolved candidate churn. No parallel
 * mechanism exists or is needed.
 *
 * Absence stays explicit (AC3): compiling a request without entries or
 * public surfaces yields empty sets plus recorded contextual assumptions
 * — undefined reachability over those surfaces, never a clean result and
 * never a confirmed-dead-code claim. Plugin discovery is disabled
 * unconditionally (AC4): the compiled policy carries the fact as
 * `pluginDiscovery: "disabled"` plus its assumption, because the schema
 * accepts no plugin vocabulary at all — enabling any plugin is a
 * separately declared trust-boundary decision, never a configuration
 * knob.
 */
import {
	type KnipProviderRequest,
	knipProviderRequestSchema,
	MAX_REACHABILITY_ENTRY_FILES,
	MAX_REACHABILITY_EXPORT_NAME_LENGTH,
	MAX_REACHABILITY_PATH_LENGTH,
	MAX_REACHABILITY_PUBLIC_SURFACES,
	type ProviderOptions,
	REACHABILITY_POLICY_VERSION,
	type ReachabilityPublicSurface,
	type ReachabilityTestMode,
} from "../../contract/index.ts";
import { sha256Hex } from "../staging.ts";

/**
 * The closed contextual-assumption vocabulary (AC3): every id records a
 * surface over which reachability is **undefined** — and undefined
 * reachability can only produce advisory candidates, never confirmed dead
 * code. The ids, and what each records:
 *
 * - `plugin-discovery-disabled` — framework/tool plugin discovery is
 *   disabled; entry conventions of any framework are unknown here.
 *   Any future plugin support requires a separately declared trust
 *   boundary, never target configuration or plugin code (AC4).
 * - `dependency-context-unverified` — the pure preparation resolves no
 *   installed dependencies and reads no package manifests for
 *   reachability; unresolved-import and unused-dependency candidates are
 *   advisory over unverified context.
 * - `no-entries-declared` — no application/script entry is declared;
 *   module reachability from execution roots is undefined.
 * - `no-public-surfaces-declared` — no exported public surface is
 *   declared; exported symbols may be candidates without being dead.
 * - `tests-excluded` — the measured test files supply no reachability
 *   evidence; production symbols used only by tests appear as candidates.
 * - `declared-entry-not-in-selection` — a declared entry is not a measured
 *   production/test file; its reachability contribution is unrecorded.
 * - `declared-public-surface-not-in-selection` — a declared public surface
 *   is not present in the measured selection.
 * - `public-surface-not-production` — a declared public surface resolves
 *   to a non-production file (e.g. a test); public API is a production
 *   notion, so the surface is unrecorded, never reclassified.
 */
export const REACHABILITY_ASSUMPTIONS = [
	"plugin-discovery-disabled",
	"dependency-context-unverified",
	"no-entries-declared",
	"no-public-surfaces-declared",
	"tests-excluded",
	"declared-entry-not-in-selection",
	"declared-public-surface-not-in-selection",
	"public-surface-not-production",
] as const;
export type ReachabilityAssumptionId = (typeof REACHABILITY_ASSUMPTIONS)[number];

/**
 * One recorded contextual assumption: the closed id plus the repo-relative
 * paths it is about (empty for context-wide assumptions). The paths are
 * sorted and unique — an assumption is one canonical record per surface.
 */
export interface ReachabilityAssumption {
	/** The closed assumption id (see {@link REACHABILITY_ASSUMPTIONS}). */
	id: ReachabilityAssumptionId;
	/** The sorted paths the assumption is about; empty when context-wide. */
	paths: readonly string[];
}

/**
 * The compiled reachability policy: the normalized declaration, the
 * evaluation bounds it was validated under, and the identity pieces the
 * adapter records (canonical serialization, digest, provider-options
 * fragment) plus the declaration-level contextual assumptions.
 */
export interface CompiledReachabilityPolicy {
	/** The declarative subset's version (`REACHABILITY_POLICY_VERSION`) — part of identity. */
	version: number;
	/** Plugin discovery is always disabled (AC4) — a fact of the compiled semantics. */
	pluginDiscovery: "disabled";
	/** The declared entry paths in sorted order — production/test resolution is preparation's. */
	entries: readonly string[];
	/** The declared public surfaces in canonical order (path, then file-level before named). */
	publicSurfaces: readonly ReachabilityPublicSurface[];
	/** The test-participation mode; an absent declaration compiles to `excluded`. */
	testMode: ReachabilityTestMode;
	/** The declaration bounds the request was validated under. */
	bounds: Readonly<{
		maxEntryFiles: number;
		maxPublicSurfaces: number;
		maxPathLength: number;
		maxExportNameLength: number;
	}>;
	/** The canonical serialization the digest is computed over. */
	canonical: string;
	/** The sha-256 digest of `canonical` — the normalized configuration identity fingerprint. */
	digest: string;
	/**
	 * The §16.2 provider-options fragment carrying the configuration
	 * identity (version, counts, test mode, digest): the step-6 seam the
	 * adapter merges into `ProviderIdentity.options` so compatibility, not
	 * a parallel mechanism, decides comparability.
	 */
	identityOptions: ProviderOptions;
	/** The declaration-level contextual assumptions (see {@link REACHABILITY_ASSUMPTIONS}). */
	assumptions: readonly ReachabilityAssumption[];
}

/** Sort one public surface canonically: by path, file-level before named exports, then by name. */
function comparePublicSurfaces(a: ReachabilityPublicSurface, b: ReachabilityPublicSurface): number {
	if (a.path !== b.path) return a.path < b.path ? -1 : 1;
	const aName = a.export ?? "";
	const bName = b.export ?? "";
	return aName < bName ? -1 : aName > bName ? 1 : 0;
}

/** One recorded assumption; assumes `paths` is sorted and unique. */
function assumption(
	id: ReachabilityAssumptionId,
	paths: readonly string[] = [],
): ReachabilityAssumption {
	return { id, paths };
}

/**
 * Compile a Knip request into the normalized reachability policy. Pure and
 * deterministic: the request is re-validated against the declarative
 * schema (so compilation is total over schema-shaped input and throws
 * actionable zod errors on anything else), entries and public surfaces
 * are ordered canonically, and the canonical serialization plus its
 * digest are the policy's identity. A request without entries or public
 * surfaces compiles to explicit emptiness plus recorded assumptions —
 * nothing is inferred, nothing is defaulted, nothing is clean.
 */
export function compileReachabilityPolicy(
	request: KnipProviderRequest,
): CompiledReachabilityPolicy {
	const parsed = knipProviderRequestSchema.parse(request);
	const entries = [...(parsed.entries ?? [])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	const publicSurfaces = [...(parsed.public ?? [])].sort(comparePublicSurfaces);
	const testMode = parsed.tests ?? "excluded";
	const canonical = JSON.stringify({
		version: REACHABILITY_POLICY_VERSION,
		pluginDiscovery: "disabled",
		testMode,
		entries,
		public: publicSurfaces.map((surface) =>
			surface.export === undefined
				? { path: surface.path }
				: { path: surface.path, export: surface.export },
		),
	});
	const digest = sha256Hex(canonical);
	const assumptions: ReachabilityAssumption[] = [assumption("plugin-discovery-disabled")];
	if (entries.length === 0) assumptions.push(assumption("no-entries-declared"));
	if (publicSurfaces.length === 0) assumptions.push(assumption("no-public-surfaces-declared"));
	return {
		version: REACHABILITY_POLICY_VERSION,
		pluginDiscovery: "disabled",
		entries,
		publicSurfaces,
		testMode,
		bounds: {
			maxEntryFiles: MAX_REACHABILITY_ENTRY_FILES,
			maxPublicSurfaces: MAX_REACHABILITY_PUBLIC_SURFACES,
			maxPathLength: MAX_REACHABILITY_PATH_LENGTH,
			maxExportNameLength: MAX_REACHABILITY_EXPORT_NAME_LENGTH,
		},
		canonical,
		digest,
		identityOptions: {
			"reachability-policy-version": REACHABILITY_POLICY_VERSION,
			"reachability-entry-count": entries.length,
			"reachability-public-surface-count": publicSurfaces.length,
			"reachability-test-mode": testMode,
			"reachability-policy-digest": `sha256:${digest}`,
		},
		assumptions,
	};
}
