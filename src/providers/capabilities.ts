/**
 * Supported-provider capability metadata (SPEC §16.1/§16.2/§16.7 —
 * `trellis-db3e`, plan `pl-43c5` step 25).
 *
 * The static, typed record of the external quality-evidence providers
 * trellis knows — so a provider request can be validated as *known*
 * configuration before any adapter exists (SPEC §16.2/§16.3; unknown ids
 * are operational errors) — together with the capabilities each is
 * contracted to own and the support status of those capabilities today.
 * This is metadata, not a runtime: no adapter, resolution, or execution
 * lives here. Adapter-owning steps update their entry when they deliver;
 * request surfaces read the recorded status and reason so a not-yet-
 * delivered or gated capability is reported truthfully as `unsupported`,
 * never as a clean result (§16.2).
 *
 * The SonarJS entry carries the recorded distribution and metric-interface
 * decision (`docs/sonarjs-decision.md`, SPEC §16.7): the outcome is
 * explicitly **deferred**, so a `sonarjs` request resolves to `unsupported`
 * with the recorded reason — visible, policy-testable, never a claimed
 * implementation.
 *
 * Scoring (SPEC §16.5) is structurally recorded: every entry pins
 * `unscored: true` as a schema literal, so this metadata cannot declare a
 * scored capability or a new scoring weight without a schema change — which
 * is the point.
 */
import { z } from "zod";
import {
	capabilityDeclarationsSchema,
	dottedIdSchema,
	NATIVE_NAMESPACE,
	type ProviderCapability,
	providerIdSchema,
	providerStateSchema,
	relativePathSchema,
} from "../contract/index.ts";

/**
 * Delivery statuses a known provider's capability set can carry in this
 * table. `delivered` means an executable adapter exists and requests resolve
 * **per run** (complete/incomplete/unavailable as the execution observes —
 * never a fixed state). `adapter-pending` and `deferred` mean **no
 * executable capability exists today**: either no adapter is delivered yet
 * or the capability is gated by a recorded decision. Request surfaces read
 * the recorded status and reason so an undelivered or gated capability is
 * reported truthfully as `unsupported`, never as a clean result (§16.2).
 */
export const PROVIDER_SUPPORT_STATUSES = ["delivered", "adapter-pending", "deferred"] as const;
export type ProviderSupportStatus = (typeof PROVIDER_SUPPORT_STATUSES)[number];

/** Seeds tracker id shape (`trellis-db3e`). */
const seedsIdSchema = z.string().regex(/^trellis-[a-z0-9]{4}$/, "must be a seeds tracker id");

/** Repo-relative decision record path (`docs/sonarjs-decision.md`). */
const decisionRecordPathSchema = relativePathSchema.refine(
	(path) => path.startsWith("docs/"),
	"the decision record is a repo-relative path under docs/",
);

/**
 * The recorded decision behind a `deferred` status (SPEC §16.7). The
 * outcome is a literal `deferred`: clearance is never recorded by editing
 * this value — it is a new versioned change that revises this schema with
 * the clearance evidence.
 */
export const deferredDecisionSchema = z.strictObject({
	outcome: z.literal("deferred"),
	record: decisionRecordPathSchema,
	issue: seedsIdSchema,
	/** The separately tracked prerequisite that would clear the deferral. */
	prerequisite: seedsIdSchema,
});
export type DeferredDecision = z.infer<typeof deferredDecisionSchema>;

/**
 * One known external provider: its id, the capabilities it is contracted
 * to own, its current support status, the state a request resolves to
 * while that status stands, and the located reason recorded with it.
 */
export const providerCapabilityStatusSchema = z
	.strictObject({
		providerId: providerIdSchema,
		/** Dotted capability ids owned by this provider (unique across providers — validated below). */
		capabilityIds: z.array(dottedIdSchema).min(1),
		/** SPEC §16.5, structural: this metadata cannot declare a scored capability. */
		unscored: z.literal(true),
		status: z.enum(PROVIDER_SUPPORT_STATUSES),
		/**
		 * The SPEC §16.2 state a request for this provider resolves to while
		 * this entry stands — required and `unsupported` for undelivered
		 * capabilities, **absent** for `delivered` ones (their requests
		 * resolve per run, as the execution observes, never to a fixed state).
		 */
		requestState: providerStateSchema.optional(),
		/** Located reason recorded with the state (never empty; shown with `unsupported` evidence). */
		reason: z.string().min(1),
		/** Required for `deferred`; forbidden otherwise. */
		decision: deferredDecisionSchema.optional(),
	})
	.superRefine((entry, ctx) => {
		const isNativeNamespace =
			entry.providerId === NATIVE_NAMESPACE || entry.providerId.startsWith(`${NATIVE_NAMESPACE}.`);
		if (isNativeNamespace) {
			ctx.addIssue({
				code: "custom",
				message: "external provider metadata must not use the reserved 'trellis.' namespace",
				path: ["providerId"],
			});
		}
		if (entry.status === "delivered") {
			if (entry.requestState !== undefined) {
				ctx.addIssue({
					code: "custom",
					message:
						"a delivered capability resolves per run — requestState records only capabilities whose requests cannot execute",
					path: ["requestState"],
				});
			}
		} else if (entry.requestState !== "unsupported") {
			ctx.addIssue({
				code: "custom",
				message:
					"a provider in this table has no executable capability: its requests resolve to 'unsupported'",
				path: ["requestState"],
			});
		}
		if (entry.status === "deferred" && entry.decision === undefined) {
			ctx.addIssue({
				code: "custom",
				message: "a deferred provider must carry the recorded decision",
				path: ["status"],
			});
		}
		if (entry.status !== "deferred" && entry.decision !== undefined) {
			ctx.addIssue({
				code: "custom",
				message: "only a deferred provider carries a decision record",
				path: ["decision"],
			});
		}
	});
export type ProviderCapabilityStatus = z.infer<typeof providerCapabilityStatusSchema>;

/**
 * The known external provider set (SPEC §16.1's contracted candidates).
 * Validated at module load: every entry against
 * {@link providerCapabilityStatusSchema} and the flattened capability set
 * against the contract's {@link capabilityDeclarationsSchema} (unique
 * ownership across providers), so a drifted table fails here, loudly,
 * before any consumer reads it.
 */
export const SUPPORTED_PROVIDERS: readonly ProviderCapabilityStatus[] = (() => {
	const table: readonly ProviderCapabilityStatus[] = [
		{
			providerId: "jscpd",
			capabilityIds: ["duplication.exact", "duplication.normalized", "duplication.near"],
			unscored: true,
			status: "delivered",
			reason:
				"duplication-evidence adapter delivered (src/providers/jscpd/, trellis-f4e2) and selectable through declarative provider configuration (plan pl-43c5 step 15, trellis-15e3): requests resolve per run",
		},
		{
			providerId: "dependency-cruiser",
			capabilityIds: ["architecture.declared-rules"],
			unscored: true,
			status: "delivered",
			reason:
				"architecture-evidence adapter delivered (src/providers/dependency-cruiser/, trellis-adbf) evaluating the declarative architecture-policy subset over staged views and selectable through declarative provider configuration: requests resolve per run",
		},
		{
			providerId: "knip",
			capabilityIds: ["reachability.contextual"],
			unscored: true,
			status: "delivered",
			reason:
				"reachability-evidence adapter delivered (src/providers/knip/, trellis-8ebc) evaluating the " +
				"prepared declarative reachability context over staged views with every runtime plugin " +
				"disabled and selectable through declarative provider configuration: requests resolve per run",
		},
		{
			providerId: "sonarjs",
			capabilityIds: ["reasoning.cognitive-complexity", "bugs.selected-syntax-rules"],
			unscored: true,
			status: "deferred",
			requestState: "unsupported",
			reason:
				"explicitly deferred by the distribution and metric-interface decision (docs/sonarjs-decision.md): the pinned eslint-plugin-sonarjs 3.0.5 distribution carries conflicting license evidence (LGPL-3.0-only package metadata vs SONAR Source-Available License v1.0 shipped headers) and no permitted distribution route is established",
			decision: {
				outcome: "deferred",
				record: "docs/sonarjs-decision.md",
				issue: "trellis-db3e",
				prerequisite: "trellis-7f5d",
			},
		},
	];
	const validated = z.array(providerCapabilityStatusSchema).parse(table);
	capabilityDeclarationsSchema.parse(
		validated.flatMap((entry) =>
			entry.capabilityIds.map((capabilityId) => ({
				providerId: entry.providerId,
				capabilityId,
			})),
		),
	);
	return validated;
})();

/** Whether `id` names a known external provider (unknown ids are operational errors, SPEC §16.3). */
export function isKnownProviderId(id: string): boolean {
	return SUPPORTED_PROVIDERS.some((entry) => entry.providerId === id);
}

/** The recorded capability status for a known provider id; `undefined` for unknown ids. */
export function providerCapabilityStatus(id: string): ProviderCapabilityStatus | undefined {
	return SUPPORTED_PROVIDERS.find((entry) => entry.providerId === id);
}

/** The capability declarations implied by the table (ownership already validated at load). */
export function supportedCapabilityDeclarations(): ProviderCapability[] {
	return SUPPORTED_PROVIDERS.flatMap((entry) =>
		entry.capabilityIds.map((capabilityId) => ({ providerId: entry.providerId, capabilityId })),
	);
}

/**
 * The candidate acceptance set a cleared SonarJS route must keep passing
 * (`trellis-db3e` acceptance 4): six metric controls and six bug-rule
 * controls (three rules × positive/negative). Canonical fixture values
 * live in `docs/research/sonar-provider-spike/fixtures.json`; these
 * constants pin the control names and rules so the set cannot be silently
 * swapped — `capabilities.test.ts` cross-checks them against the fixtures.
 */
export const SONARJS_METRIC_CONTROLS = [
	"nested",
	"guards",
	"extracted",
	"legitimate-dispatch",
	"direct",
	"forwarding-layers",
] as const;

export const SONARJS_BUG_RULE_CONTROLS = [
	"no-identical-expressions",
	"no-identical-conditions",
	"no-element-overwrite",
] as const;
