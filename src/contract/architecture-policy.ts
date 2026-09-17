/**
 * Declarative architecture-policy contract (SPEC §16.1/§16.4 — plan
 * `pl-43c5` step 21, trellis-89be).
 *
 * A bounded dependency-cruiser policy subset: declared module boundaries,
 * cycle checks and unresolved-import checks expressed as **data** — never
 * an executable `.dependency-cruiser` config, never a general policy
 * language. Bounded on purpose (trellis-89be): every rule is one of three
 * closed kinds, every scope selector is a start-anchored regular expression
 * over repo-relative POSIX paths, and evaluation requirements are capped
 * (rule count, pattern length, name length), so a declared policy is always
 * finite, deterministic and cheap to evaluate — and always parsable without
 * executing anything.
 *
 * Rule semantics (declared here; the adapter evaluates them — step 22,
 * trellis-adbf):
 *
 * - `boundary` — a `forbidden` boundary is violated when a module matching
 *   `from` imports a module matching `to` over the declared edge kinds; an
 *   `allowed` boundary is an explicit exception — a dependency that
 *   matches it is exempt from every `forbidden` boundary (allowed wins).
 *   Selectors are always explicit: there is no implicit "anywhere"
 *   selector, and no layering policy is ever inferred from directory names
 *   (AC4).
 * - `cycle` — a dependency cycle over the declared edge kinds among the
 *   selected modules. `edges` keeps runtime and type-only cycle policies
 *   distinct (provider-spike record: the two cycle flavors are reported
 *   separately and must never be merged into one penalty).
 * - `unresolved` — an import that could not be resolved is a violation.
 *
 * **Absence is explicit, never coherence (AC4):** `rules` is optional — a
 * request without rules declares *no* architecture claims, no default
 * rules are injected, and zero rules can never be read as a clean
 * architecture. The pure compilation (`src/providers/dependency-cruiser/
 * policy.ts`) records the declared rule count and a normalized digest so
 * the absence itself is visible, comparable identity.
 *
 * Rejections (AC2, all actionable at config-load time — operational exit
 * `1`, SPEC §16.3): unknown rule kinds and unknown keys (strict objects and
 * the closed kind union — a pasted executable dependency-cruiser config or
 * a path to a rule file cannot parse), ambiguous rule sets (duplicate
 * names, duplicate semantics, a `forbidden`/`allowed` pair over identical
 * selectors and edge kinds), and invalid patterns (unanchored, absolute,
 * traversal, uncompileable, over-length).
 */
import { z } from "zod";

/**
 * The edge kinds a declared rule can govern (§16.1; provider-spike record:
 * runtime and type-only dependency edges are distinct flavors and stay
 * distinct in every declared policy).
 */
export const DEPENDENCY_EDGE_KINDS = ["runtime", "type-only"] as const;
export type DependencyEdgeKind = (typeof DEPENDENCY_EDGE_KINDS)[number];
export const dependencyEdgeKindSchema = z.enum(DEPENDENCY_EDGE_KINDS);

/** Whether a boundary forbids the declared dependency or allows it as an exception. */
export const ARCHITECTURE_ALLOWANCES = ["forbidden", "allowed"] as const;
export type ArchitectureAllowance = (typeof ARCHITECTURE_ALLOWANCES)[number];
export const architectureAllowanceSchema = z.enum(ARCHITECTURE_ALLOWANCES);

/**
 * The declarative subset's version — part of the normalized policy identity
 * (`src/providers/dependency-cruiser/policy.ts`). Bumping it is a semantics
 * change: compiled identities then differ even for byte-identical rule
 * sets, so evidence never silently continues across a changed rule
 * vocabulary.
 */
export const ARCHITECTURE_POLICY_VERSION = 1;

/**
 * Evaluation bounds (AC2): a declared policy is always finite and cheap to
 * evaluate. Rule sets, patterns and names are capped at parse time; the
 * compiled policy records the bounds it was validated under.
 */
export const MAX_ARCHITECTURE_RULES = 32;
export const MAX_ARCHITECTURE_PATTERN_LENGTH = 256;
export const MAX_ARCHITECTURE_RULE_NAME_LENGTH = 64;

/**
 * A scope-selector pattern: a start-anchored regular expression matched
 * against repo-relative POSIX paths (`^src/domain/`). Unanchored patterns
 * are ambiguous (they match a path at any depth), so the anchor is required;
 * absolute paths and `..` traversal never select anything inside the
 * audited root and are rejected as invalid, not silently dead.
 */
export const architecturePathPatternSchema = z
	.string()
	.min(2)
	.max(MAX_ARCHITECTURE_PATTERN_LENGTH)
	.superRefine((pattern, ctx) => {
		if (!pattern.startsWith("^")) {
			ctx.addIssue({
				code: "custom",
				message:
					"must be a start-anchored pattern (begin with '^') — unanchored selectors are ambiguous",
				path: [],
			});
		}
		if (pattern.startsWith("^/")) {
			ctx.addIssue({
				code: "custom",
				message: "must match repo-relative POSIX paths, not absolute paths",
				path: [],
			});
		}
		if (pattern.includes("..")) {
			ctx.addIssue({
				code: "custom",
				message: "must not contain '..' — selectors stay inside the audited root",
				path: [],
			});
		}
		try {
			new RegExp(pattern);
		} catch {
			ctx.addIssue({
				code: "custom",
				message: "must be a valid regular expression",
				path: [],
			});
		}
	});
export type ArchitecturePathPattern = z.infer<typeof architecturePathPatternSchema>;

/**
 * A scope selector: exactly one key — the path pattern. A strict object so
 * unknown selector vocabulary (dependency-cruiser's `orphan`,
 * `circular`, `reachable`, …) is rejected actionably instead of being
 * reinterpreted.
 */
export const architectureScopeSelectorSchema = z.strictObject({
	path: architecturePathPatternSchema,
});
export type ArchitectureScopeSelector = z.infer<typeof architectureScopeSelectorSchema>;

/** Rule names: kebab-case identifiers, unique within one policy (validated below). */
const architectureRuleNameSchema = z
	.string()
	.regex(/^[a-z][a-z0-9-]*$/, "must be a kebab-case identifier")
	.max(MAX_ARCHITECTURE_RULE_NAME_LENGTH);

/** Strictly increasing (unique, deterministically sorted) string values. */
function isSortedUnique(values: readonly string[]): boolean {
	for (let i = 1; i < values.length; i++) {
		const previous = values[i - 1];
		const current = values[i];
		if (previous === undefined || current === undefined || previous >= current) {
			return false;
		}
	}
	return true;
}

/**
 * The edge kinds one rule governs: explicit (never defaulted — a rule that
 * governs nothing is not declarable), unique and sorted so one declared
 * policy always has one canonical form.
 */
export const architectureEdgeKindsSchema = z
	.array(dependencyEdgeKindSchema)
	.min(1)
	.superRefine((edges, ctx) => {
		if (!isSortedUnique(edges)) {
			ctx.addIssue({
				code: "custom",
				message:
					"edge kinds must be unique and sorted (e.g. [runtime] or [runtime, type-only]) — one rule, one canonical edge set",
				path: [],
			});
		}
	});

/**
 * A declared boundary: an explicit `from`/`to` scope-selector pair and the
 * edge kinds it governs. `forbidden` names a violation; `allowed` is an
 * explicit exception that exempts a matching dependency from every
 * `forbidden` boundary.
 */
export const architectureBoundaryRuleSchema = z.strictObject({
	kind: z.literal("boundary"),
	name: architectureRuleNameSchema,
	allowance: architectureAllowanceSchema,
	edges: architectureEdgeKindsSchema,
	from: architectureScopeSelectorSchema,
	to: architectureScopeSelectorSchema,
});
export type ArchitectureBoundaryRule = z.infer<typeof architectureBoundaryRuleSchema>;

/**
 * A declared cycle check over the named edge kinds. `edges` is what
 * distinguishes a type-only cycle policy from a runtime one — the two are
 * separate rules with separate identities, never one merged penalty.
 */
export const architectureCycleRuleSchema = z.strictObject({
	kind: z.literal("cycle"),
	name: architectureRuleNameSchema,
	edges: architectureEdgeKindsSchema,
});
export type ArchitectureCycleRule = z.infer<typeof architectureCycleRuleSchema>;

/** A declared unresolved-import check: an unresolvable import is a violation. */
export const architectureUnresolvedRuleSchema = z.strictObject({
	kind: z.literal("unresolved"),
	name: architectureRuleNameSchema,
});
export type ArchitectureUnresolvedRule = z.infer<typeof architectureUnresolvedRuleSchema>;

/** One declared rule — a closed union: boundary, cycle, or unresolved. */
export const architectureRuleSchema = z.discriminatedUnion("kind", [
	architectureBoundaryRuleSchema,
	architectureCycleRuleSchema,
	architectureUnresolvedRuleSchema,
]);
export type ArchitectureRule = z.infer<typeof architectureRuleSchema>;

/** The canonical semantics of one rule — the duplicate/ambiguity comparison key. */
function ruleSemanticsKey(rule: ArchitectureRule): string {
	switch (rule.kind) {
		case "boundary":
			return ["boundary", rule.allowance, rule.edges.join("+"), rule.from.path, rule.to.path].join(
				"|",
			);
		case "cycle":
			return ["cycle", rule.edges.join("+")].join("|");
		case "unresolved":
			return "unresolved";
	}
}

/**
 * A dependency-cruiser provider request: the declared architecture policy,
 * inline. `rules` is optional — an absent (or empty) rule set is valid
 * configuration that declares **no** architecture claims (AC4: absence is
 * never coherence, and nothing is inferred from directory names); the
 * compiled policy carries the zero-rule fact as visible identity.
 *
 * Cross-rule ambiguity is rejected here (AC2): duplicate names, duplicate
 * rule semantics under different names, and a `forbidden`/`allowed` pair
 * over identical selectors and edge kinds (a direct contradiction).
 */
export const dependencyCruiserProviderRequestSchema = z
	.strictObject({
		rules: z.array(architectureRuleSchema).max(MAX_ARCHITECTURE_RULES).optional(),
	})
	.superRefine((request, ctx) => {
		const rules = request.rules ?? [];
		const nameIndex = new Map<string, number>();
		const semanticsName = new Map<string, string>();
		const selectorAllowance = new Map<string, ArchitectureAllowance>();
		for (const [index, rule] of rules.entries()) {
			const previousIndex = nameIndex.get(rule.name);
			if (previousIndex !== undefined) {
				ctx.addIssue({
					code: "custom",
					message: `rule name "${rule.name}" is declared twice (rules ${previousIndex} and ${index}) — rule names must be unique`,
					path: ["rules", index, "name"],
				});
			} else {
				nameIndex.set(rule.name, index);
			}
			const semantics = ruleSemanticsKey(rule);
			const previousName = semanticsName.get(semantics);
			if (previousName !== undefined) {
				ctx.addIssue({
					code: "custom",
					message: `rule "${rule.name}" repeats the semantics of "${previousName}" — declare one rule per check`,
					path: ["rules", index],
				});
			} else {
				semanticsName.set(semantics, rule.name);
			}
			if (rule.kind === "boundary") {
				const selectorKey = [rule.from.path, rule.to.path, rule.edges.join("+")].join("|");
				const otherAllowance = selectorAllowance.get(selectorKey);
				if (otherAllowance !== undefined && otherAllowance !== rule.allowance) {
					ctx.addIssue({
						code: "custom",
						message: `rules over the same selectors and edge kinds cannot be both forbidden and allowed — "${rule.name}" contradicts an existing boundary`,
						path: ["rules", index, "allowance"],
					});
				} else if (otherAllowance === undefined) {
					selectorAllowance.set(selectorKey, rule.allowance);
				}
			}
		}
	});
export type DependencyCruiserProviderRequest = z.infer<
	typeof dependencyCruiserProviderRequestSchema
>;
