/**
 * Audit configuration contract (SPEC §6.5, §16.3 — plan `pl-43c5` step 15,
 * trellis-15e3) — declarative data, never code.
 *
 * Per-repo configuration (`trellis.yaml`, optional; sensible defaults without
 * it) describes source exclusions/classification, optional provider
 * selection, and the failure policy. It contains **no executable hooks**: the
 * schema is pure data (strings, numbers, lists, maps), and strict objects
 * reject any unknown key — including any attempt to smuggle in hook commands
 * or to override scoring weights. Policy budgets gate the run (§9); they
 * never mutate how the index is computed (§7).
 *
 * **Provider selection (§16.4)** is the `providers` block: a strict map of
 * known optional-provider ids to per-provider request data. Selection is
 * *additive evidence only* — a requested provider never changes the native
 * measurement or the score (§16.5), and an absent block (the default)
 * requests nothing, so the default audit stays offline, no-write and
 * byte-identical to the native-only pipeline. Unknown provider ids are
 * rejected by the schema itself (an unknown request is invalid configuration,
 * an operational error, §16.3 — never a silently ignored key); requesting a
 * provider whose adapter is not delivered (or is gated, like SonarJS §16.7)
 * is *valid* configuration and resolves to located `unsupported` evidence.
 *
 * Loading/discovery of the config file itself lives in `src/config/load.ts`
 * (trellis-6003); this module defines only the contract.
 */
import { z } from "zod";
import { dependencyCruiserProviderRequestSchema } from "./architecture-policy.ts";
import { CLONE_MATCH_MODES } from "./clone-evidence.ts";
import { SOURCE_SETS } from "./coverage.ts";
import { dottedIdSchema, finiteNumberSchema } from "./primitives.ts";
import { EVIDENCE_NAMESPACE, NATIVE_NAMESPACE } from "./provider.ts";
import { knipProviderRequestSchema } from "./reachability-policy.ts";

/**
 * Source handling: `exclude` adds glob exclusions to the documented defaults;
 * `classify` maps globs to explicit source-set overrides (SPEC §3.1, §6.5).
 */
export const sourceConfigSchema = z.strictObject({
	exclude: z.array(z.string().min(1)).default([]),
	classify: z.record(z.string().min(1), z.enum(SOURCE_SETS)).default({}),
});

export type SourceConfig = z.infer<typeof sourceConfigSchema>;

/** A metric budget: the run fails when the measured value exceeds `max`. */
export const metricBudgetSchema = z.strictObject({
	max: finiteNumberSchema.nonnegative(),
});

export type MetricBudget = z.infer<typeof metricBudgetSchema>;

/**
 * Score-regression tolerance against a baseline report (SPEC §9). The two
 * knobs are independent bounds, documented by kind:
 *
 * - `maxIncrease` — **absolute** tolerance in index points (0–100 scale):
 *   the run fails when `current.index - baseline.index` exceeds it.
 * - `maxIncreasePercent` — **relative** tolerance as a percentage of the
 *   baseline index: the run fails when the increase exceeds
 *   `baseline.index × maxIncreasePercent / 100`.
 *
 * When both are set, exceeding either bound fails. A `regression` block with
 * neither knob tolerates zero increase. Evaluation lives in
 * `src/compare/policy.ts` (trellis-942c).
 */
export const regressionPolicySchema = z.strictObject({
	maxIncrease: finiteNumberSchema.min(0).max(100).optional(),
	maxIncreasePercent: finiteNumberSchema.min(0).optional(),
});

export type RegressionPolicy = z.infer<typeof regressionPolicySchema>;

/**
 * A required optional-provider analysis id (SPEC §16.3 — plan `pl-43c5` step 7,
 * trellis-68b9). `requireEvidence` *demands* provider evidence: a required
 * analysis that is unrequested, unavailable, unsupported or incomplete fails
 * the policy closed (exit `2`, report still emitted) even when the native
 * score is complete and clean — while an absent optional provider with no
 * requirement never violates policy and never touches the score (§16.5).
 *
 * The values are **supported analysis ids** — the external provider ids of the
 * supported-provider capability table (`src/providers/capabilities.ts`). Two
 * near-miss vocabularies are rejected here, at parse time, as actionable
 * configuration errors (operational exit `1`, SPEC §16.3):
 *
 * - native analyzer ids (`trellis.*`) — native analyzers always run; their
 *   gaps are governed by metric budgets and the score's own completeness,
 *   never by evidence requirements;
 * - namespaced evidence ids (`provider.<id>.<metric>`) — those name a
 *   provider's *evidence*, not the analysis itself; `budgets` is the surface
 *   that consumes them.
 *
 * A requirement is declarative data only: it never selects scoring weights,
 * never executes a provider implicitly, and accepts no command strings.
 */
const requiredAnalysisIdSchema = dottedIdSchema.superRefine((id, ctx) => {
	if (id === NATIVE_NAMESPACE || id.startsWith(`${NATIVE_NAMESPACE}.`)) {
		ctx.addIssue({
			code: "custom",
			message:
				"policy requirements demand optional provider evidence — native analyzers always run and are governed by metric budgets, never by requireEvidence",
		});
	}
	if (id.startsWith(`${EVIDENCE_NAMESPACE}.`)) {
		ctx.addIssue({
			code: "custom",
			message:
				'policy requirements name an analysis id ("jscpd"), not a namespaced evidence id ("provider.jscpd.pairs") — budgets consume evidence ids',
		});
	}
});

/**
 * One jscpd duplication-evidence request (§16.1, §16.2): the match mode the
 * analysis runs — the provider identity's mode and the option set that
 * distinguish its evidence (§16.6). Exactly one mode per request: the report
 * carries one evidence entry per provider id, and the per-mode normalized
 * metrics share ids, so two modes of the same provider can never be folded
 * into one honest entry — a different mode is a different analysis identity,
 * never a silent reconfiguration of the same evidence.
 *
 * The pinned detection thresholds are not configurable here: they are the
 * conformance-validated calibration (`src/providers/jscpd/invocation.ts`),
 * part of the analysis identity, and changing them is a separately versioned
 * decision — never an audit-time knob.
 */
export const jscpdProviderRequestSchema = z.strictObject({
	mode: z.enum(CLONE_MATCH_MODES),
});

export type JscpdProviderRequest = z.infer<typeof jscpdProviderRequestSchema>;

/**
 * A request for a provider whose adapter is not delivered (or is gated, like
 * SonarJS §16.7): valid configuration — the id is known — carrying no
 * options, because no executable capability exists to configure. It
 * resolves to located `unsupported` evidence with the capability table's
 * recorded reason (`src/providers/capabilities.ts`). Adapter-owning steps
 * replace this shape with their own request schema when they deliver.
 *
 * dependency-cruiser already carries its declarative architecture-rule
 * subset (trellis-89be, `src/contract/architecture-policy.ts`) while its
 * adapter is still pending: such a request is valid configuration — the
 * pure compilation lives in `src/providers/dependency-cruiser/policy.ts` —
 * and still resolves to located `unsupported` evidence until the adapter
 * delivers (trellis-adbf).
 *
 * knip likewise already carries its declarative reachability-context
 * subset (trellis-5da5, `src/contract/reachability-policy.ts`): explicit
 * application/script entries, exported public surfaces and test
 * participation as reachability roots. Such a request is valid
 * configuration — the pure compilation and context preparation live in
 * `src/providers/knip/` — and still resolves to located `unsupported`
 * evidence until the adapter delivers (trellis-8ebc).
 */
export const undeliveredProviderRequestSchema = z.strictObject({});

export type UndeliveredProviderRequest = z.infer<typeof undeliveredProviderRequestSchema>;

/**
 * Optional provider selection (§16.4): exactly the requestable provider ids,
 * each with its own request shape — an unknown id is an unrecognized key, so
 * the schema itself keeps the vocabulary honest (§16.3). The key set is
 * cross-checked against the supported-provider capability table by the
 * contract tests; keep both in sync when a provider ships.
 */
export const providerSelectionSchema = z.strictObject({
	jscpd: jscpdProviderRequestSchema.optional(),
	"dependency-cruiser": dependencyCruiserProviderRequestSchema.optional(),
	knip: knipProviderRequestSchema.optional(),
	sonarjs: undeliveredProviderRequestSchema.optional(),
});

export type ProviderSelection = z.infer<typeof providerSelectionSchema>;

/**
 * Failure policy only — never mutates scoring weights (SPEC §6.5, §7).
 * `failOnNew` lists finding kinds whose appearance relative to a baseline
 * fails the run (§9). `budgets` may name native metric ids or a provider's
 * namespaced evidence ids (`provider.<id>.<metric>`, evaluated only over that
 * analysis's carried evidence); `requireEvidence` lists the optional provider
 * analyses whose evidence the policy demands (§16.3).
 */
export const policyConfigSchema = z.strictObject({
	maxIndex: finiteNumberSchema.min(0).max(100).optional(),
	regression: regressionPolicySchema.optional(),
	budgets: z.record(dottedIdSchema, metricBudgetSchema).default({}),
	failOnNew: z.array(dottedIdSchema).default([]),
	requireEvidence: z.array(requiredAnalysisIdSchema).default([]),
});

export type PolicyConfig = z.infer<typeof policyConfigSchema>;

export const auditConfigSchema = z.strictObject({
	source: sourceConfigSchema.prefault({}),
	providers: providerSelectionSchema.prefault({}),
	policy: policyConfigSchema.prefault({}),
});

export type AuditConfig = z.infer<typeof auditConfigSchema>;
