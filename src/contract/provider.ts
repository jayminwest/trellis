/**
 * Provider identity and capability contracts (SPEC §16.1–16.2, trellis-90d6).
 *
 * A **provider** is a pinned, deterministic local analysis tool (SPEC §16.1)
 * — either a **native** trellis analyzer or an **external** pinned tool
 * (jscpd, dependency-cruiser, Knip, …) explicitly enabled by the operator.
 * This module types what identifies one: a stable id, the pinned tool
 * version, the trellis adapter version, and the exact mode/option set
 * supplied (§16.2), plus the capability declarations the later registry
 * (trellis-cb51) dispatches over.
 *
 * Determinism (AC1): identity carries only measurement-relevant data.
 * Machine paths, timestamps and durations are *execution metadata*, never
 * identity — they are structurally rejected here (reserved option keys) and
 * may be recorded only on `executionMetadataSchema` (analysis.ts), which
 * never feeds `measurementIdentity`.
 *
 * Namespace rules (§16.5): native analyzers own the `trellis.` id prefix;
 * external evidence ids and finding kinds own the reserved `provider.`
 * prefix (see {@link namespacedEvidenceId}) so provider evidence can never
 * collide with native metrics or native finding kinds.
 */
import { z } from "zod";
import { dottedIdSchema, finiteNumberSchema, versionStringSchema } from "./primitives.ts";

/**
 * The five allowed provider-analysis states (SPEC §16.2) — provider-only,
 * never conflated with the native analysis states (states.ts) or the native
 * completeness rollup.
 */
export const PROVIDER_STATES = [
	"unrequested",
	"unavailable",
	"unsupported",
	"incomplete",
	"complete",
] as const;
export type ProviderState = (typeof PROVIDER_STATES)[number];
export const providerStateSchema = z.enum(PROVIDER_STATES);

/**
 * Producer kinds (§16.1, AC4): native trellis analyzers and external pinned
 * tools share one minimum result interface (`analysisResultSchema`).
 */
export const PRODUCER_KINDS = ["native", "external"] as const;
export type ProducerKind = (typeof PRODUCER_KINDS)[number];
export const producerKindSchema = z.enum(PRODUCER_KINDS);

/** Id namespace owned by native trellis analyzers (`trellis.duplication`, …). */
export const NATIVE_NAMESPACE = "trellis";

/** Reserved id namespace for external-provider evidence (metrics, finding kinds). */
export const EVIDENCE_NAMESPACE = "provider";

/** Stable provider id — a dotted identifier (`trellis.duplication`, `jscpd`, `knip`). */
export const providerIdSchema = dottedIdSchema;

/**
 * Option keys reserved for execution metadata. Machine paths, timestamps and
 * durations describe *how* a run happened, never *which* analysis it was;
 * they are excluded from measurement identity (AC1) and recorded only on
 * `executionMetadataSchema`.
 */
const RESERVED_EXECUTION_OPTION_KEYS = new Set([
	"duration-ms",
	"duration",
	"elapsed-ms",
	"timestamp",
	"started-at",
	"finished-at",
	"machine-path",
	"scratch-path",
	"exit-code",
]);

const optionKeySchema = z
	.string()
	.regex(/^[a-z][a-z0-9-]*$/, "must be a kebab-case identifier")
	.refine((key) => !RESERVED_EXECUTION_OPTION_KEYS.has(key), {
		message:
			"machine paths, timestamps and durations are execution metadata, never analysis identity",
	});

/**
 * Normalized relevant configuration (§16.2): scalar options keyed by
 * kebab-case identifiers. Producers normalize away machine-specific values
 * (paths are repo-relative or absent) so identity stays deterministic.
 */
const optionValueSchema = z.union([z.string().min(1), finiteNumberSchema, z.boolean()]);
export const providerOptionsSchema = z.record(optionKeySchema, optionValueSchema);
export type ProviderOptions = z.infer<typeof providerOptionsSchema>;

/**
 * Provider identity (§16.2): stable id, pinned tool version, trellis adapter
 * version, and the exact mode/option set supplied. `kind` is explicit and
 * cross-checked against the id namespace: native analyzers live under
 * `trellis.*`, and an external tool never does.
 */
export const providerIdentitySchema = z
	.strictObject({
		kind: producerKindSchema,
		id: providerIdSchema,
		toolVersion: versionStringSchema,
		adapterVersion: versionStringSchema,
		mode: z.string().min(1),
		options: providerOptionsSchema,
	})
	.superRefine((identity, ctx) => {
		const isNativeId =
			identity.id === NATIVE_NAMESPACE || identity.id.startsWith(`${NATIVE_NAMESPACE}.`);
		if (identity.kind === "native" && !isNativeId) {
			ctx.addIssue({
				code: "custom",
				message: "a native provider id must be under the 'trellis.' namespace",
				path: ["id"],
			});
		}
		if (identity.kind === "external" && isNativeId) {
			ctx.addIssue({
				code: "custom",
				message: "an external provider id must not use the reserved 'trellis.' namespace",
				path: ["id"],
			});
		}
	});

export type ProviderIdentity = z.infer<typeof providerIdentitySchema>;

/** The namespaced identity external evidence uses: `provider.<providerId>.<name>`. */
export function namespacedEvidenceId(providerId: string, name: string): string {
	return `${EVIDENCE_NAMESPACE}.${providerId}.${name}`;
}

/** Whether `id` is evidence of the given external provider (`provider.<providerId>.…`). */
export function isNamespacedEvidenceId(id: string, providerId: string): boolean {
	return id.startsWith(`${EVIDENCE_NAMESPACE}.${providerId}.`);
}

/** One capability declaration: the provider id and a capability it provides (`jscpd` / `duplication.near`). */
export const providerCapabilitySchema = z.strictObject({
	providerId: providerIdSchema,
	capabilityId: dottedIdSchema,
});
export type ProviderCapability = z.infer<typeof providerCapabilitySchema>;

/**
 * A set of capability declarations. A capability id has exactly one owning
 * provider: duplicate declarations (by the same or a different provider) are
 * rejected so the later registry (trellis-cb51) can never dispatch
 * ambiguously (AC5).
 */
export const capabilityDeclarationsSchema = z
	.array(providerCapabilitySchema)
	.superRefine((declarations, ctx) => {
		const owners = new Map<string, string>();
		for (const [index, declaration] of declarations.entries()) {
			const previous = owners.get(declaration.capabilityId);
			if (previous !== undefined) {
				ctx.addIssue({
					code: "custom",
					message: `capability "${declaration.capabilityId}" is declared by both "${previous}" and "${declaration.providerId}"`,
					path: [index, "capabilityId"],
				});
				continue;
			}
			owners.set(declaration.capabilityId, declaration.providerId);
		}
	});
