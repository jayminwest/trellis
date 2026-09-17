/**
 * Pure architecture-policy compilation (plan `pl-43c5` step 21,
 * trellis-89be) — the declarative rule subset of
 * `src/contract/architecture-policy.ts` compiled into one deterministic,
 * normalized policy. No dependency-cruiser invocation, no process, no I/O:
 * step 22 (trellis-adbf) owns the adapter that turns the compiled rules
 * into coverage-checked evidence.
 *
 * The compiled policy is the **normalized policy identity** (AC3): rules in
 * deterministic name order, a canonical serialization, and its sha-256
 * digest. The digest rides the analysis identity through the step-6
 * conventions (`identityOptions` is a `ProviderOptions` fragment the adapter
 * merges into its `ProviderIdentity.options`, §16.2
 * `src/contract/analysis.ts`), so `producerSemanticsDifferences`
 * (`src/compare/evidence.ts` — the one seam `compatibility.ts` and the
 * evidence comparison both consume) treats a changed declared architecture
 * as a changed measurement: noncomparable evidence, never silently diffed
 * into new/resolved finding churn. No parallel mechanism exists or is
 * needed.
 *
 * Absence stays explicit (AC4): compiling a request without rules yields
 * `ruleCount: 0` and a digest that no rule-bearing policy shares — zero
 * declared rules is a recorded fact about the request, never a claim of
 * architectural coherence, and no rule is ever inferred from directory
 * names.
 */
import {
	ARCHITECTURE_POLICY_VERSION,
	type ArchitectureRule,
	type DependencyCruiserProviderRequest,
	type DependencyEdgeKind,
	dependencyCruiserProviderRequestSchema,
	MAX_ARCHITECTURE_PATTERN_LENGTH,
	MAX_ARCHITECTURE_RULE_NAME_LENGTH,
	MAX_ARCHITECTURE_RULES,
	type ProviderOptions,
} from "../../contract/index.ts";
import { sha256Hex } from "../staging.ts";

/** One compiled rule — the validated declarative rule in canonical field shape. */
export type CompiledArchitectureRule =
	| {
			kind: "boundary";
			name: string;
			allowance: "forbidden" | "allowed";
			edges: readonly DependencyEdgeKind[];
			from: string;
			to: string;
	  }
	| { kind: "cycle"; name: string; edges: readonly DependencyEdgeKind[] }
	| { kind: "unresolved"; name: string };

/**
 * The compiled architecture policy: the normalized rule set, its explicit
 * size (zero means *no declared rules*, never coherence), the evaluation
 * bounds it was validated under, and the identity pieces the adapter
 * records (canonical serialization, digest, provider-options fragment).
 */
export interface CompiledArchitecturePolicy {
	/** The declarative subset's version (`ARCHITECTURE_POLICY_VERSION`) — part of identity. */
	version: number;
	/** The rules in deterministic name order — the evaluation order. */
	rules: readonly CompiledArchitectureRule[];
	/** The declared rule count; `0` is an explicit absence, never a clean result. */
	ruleCount: number;
	/** The evaluation bounds the request was validated under (AC2). */
	bounds: Readonly<{
		maxRules: number;
		maxPatternLength: number;
		maxRuleNameLength: number;
	}>;
	/** The canonical serialization the digest is computed over. */
	canonical: string;
	/** The sha-256 digest of `canonical` — the normalized policy identity fingerprint. */
	digest: string;
	/**
	 * The §16.2 provider-options fragment carrying the policy identity
	 * (version, rule count, digest): the step-6 seam the adapter merges
	 * into `ProviderIdentity.options` so compatibility, not a parallel
	 * mechanism, decides comparability.
	 */
	identityOptions: ProviderOptions;
}

/** Compile one validated declarative rule into its canonical shape. */
function compileRule(rule: ArchitectureRule): CompiledArchitectureRule {
	switch (rule.kind) {
		case "boundary":
			return {
				kind: "boundary",
				name: rule.name,
				allowance: rule.allowance,
				edges: rule.edges,
				from: rule.from.path,
				to: rule.to.path,
			};
		case "cycle":
			return { kind: "cycle", name: rule.name, edges: rule.edges };
		case "unresolved":
			return { kind: "unresolved", name: rule.name };
	}
}

/** The canonical serialization of one compiled rule (fixed key order). */
function canonicalRule(rule: CompiledArchitectureRule): Record<string, unknown> {
	switch (rule.kind) {
		case "boundary":
			return {
				kind: rule.kind,
				name: rule.name,
				allowance: rule.allowance,
				edges: rule.edges,
				from: rule.from,
				to: rule.to,
			};
		case "cycle":
			return { kind: rule.kind, name: rule.name, edges: rule.edges };
		case "unresolved":
			return { kind: rule.kind, name: rule.name };
	}
}

/**
 * Compile a dependency-cruiser request into the normalized architecture
 * policy. Pure and deterministic: the request is re-validated against the
 * declarative schema (so compilation is total over schema-shaped input and
 * throws actionable zod errors on anything else), rules are ordered by
 * name, and the canonical serialization plus its digest are the policy's
 * identity. A request without rules compiles to an explicit zero-rule
 * policy — nothing is inferred, nothing is defaulted.
 */
export function compileArchitecturePolicy(
	request: DependencyCruiserProviderRequest,
): CompiledArchitecturePolicy {
	const parsed = dependencyCruiserProviderRequestSchema.parse(request);
	const rules = (parsed.rules ?? [])
		.map(compileRule)
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	const canonical = JSON.stringify({
		version: ARCHITECTURE_POLICY_VERSION,
		rules: rules.map(canonicalRule),
	});
	const digest = sha256Hex(canonical);
	const ruleCount = rules.length;
	return {
		version: ARCHITECTURE_POLICY_VERSION,
		rules,
		ruleCount,
		bounds: {
			maxRules: MAX_ARCHITECTURE_RULES,
			maxPatternLength: MAX_ARCHITECTURE_PATTERN_LENGTH,
			maxRuleNameLength: MAX_ARCHITECTURE_RULE_NAME_LENGTH,
		},
		canonical,
		digest,
		identityOptions: {
			"architecture-policy-version": ARCHITECTURE_POLICY_VERSION,
			"architecture-rule-count": ruleCount,
			"architecture-policy-digest": `sha256:${digest}`,
		},
	};
}
