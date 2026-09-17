/**
 * Normalization of validated dependency-cruiser observations into stable,
 * namespaced, **unscored** architecture evidence (SPEC §16.5, plan
 * `pl-43c5` step 22 — trellis-adbf).
 *
 * Input: one schema-validated raw report (`./raw.ts`) plus the compiled
 * declarative policy (`./policy.ts`) and the cruise's coverage account
 * (`./cruise-run.ts`). Output: contract findings and metrics, namespaced
 * `provider.dependency-cruiser.*` — advisory evidence, never scoring
 * inputs, never displacing the native graph analyzers. Pure: no process,
 * no filesystem, no audit wiring (`./analysis.ts` owns the fold).
 *
 * **Exact semantics:**
 *
 * - **Every reported violation counts.** Each rule violation becomes one
 *   finding of kind `provider.dependency-cruiser.<rule-name>` (the
 *   compiled rule's own name), located at the `from` module (the tool
 *   reports module-level violations, no lines), with the edge flavors
 *   (`runtime` / `type-only`, derived from the tool's own
 *   `dependencyTypes` — never merged), the resolved target, the raw
 *   specifier and, for cycles, the full violation path preserved on the
 *   finding.
 * - **`allowed` boundaries are explicit exceptions.** The tool's own
 *   `allowed` vocabulary is a whitelist with different semantics, so the
 *   exception is applied here, from the compiled policy: a violation of
 *   a forbidden boundary whose `from`/`to` match an allowed boundary over
 *   intersecting edge kinds is exempted — recorded as visible
 *   allowed-dependency evidence with the rule that exempted it, never
 *   silently dropped (the tool never saw the exception).
 * - **Production nodes and stubs stay separate.** The coverage account's
 *   represented production files and its builtin/external/unresolved
 *   stub nodes are preserved as distinct metrics; a stub is never folded
 *   into coverage and never counted as a violation by itself.
 * - **Zero rules never reads as coherence.** The declared rule count
 *   rides the identity (`./invocation.ts`); a zero-rule policy yields
 *   zero violation findings and a truthful zero — an absence of claims,
 *   never an architectural verdict.
 * - **Deterministic.** A reordered raw report over the same policy and
 *   selection normalizes to an identical result.
 */
import type { DependencyEdgeKind, Finding, MetricValue } from "../../contract/index.ts";
import { namespacedEvidenceId } from "../../contract/index.ts";
import type { CruiseCoverage } from "./cruise-run.ts";
import { missingFilesReason } from "./cruise-run.ts";
import type { CompiledArchitecturePolicy } from "./policy.ts";
import { DEPENDENCY_CRUISER_PROVIDER_ID, type RawDependencyCruiserReport } from "./raw.ts";

/** Operational error: evidence that cannot be normalized against the policy it claims to evaluate. */
export class InvalidDependencyCruiserEvidenceError extends Error {
	constructor(reason: string) {
		super(`invalid dependency-cruiser evidence: ${reason}`);
		this.name = "InvalidDependencyCruiserEvidenceError";
	}
}

/** One normalized rule violation, in the declarative policy's own vocabulary. */
export interface NormalizedViolation {
	/** The compiled rule's name. */
	rule: string;
	/** The compiled rule's kind. */
	type: "boundary" | "cycle" | "unresolved";
	/** The repo-relative `from` module (validated against the selection). */
	from: string;
	/** The resolved `to` module, or the raw specifier when unresolvable. */
	to: string;
	/** The raw import specifier as written. */
	specifier: string;
	/** The edge flavors the tool reported for this dependency — runtime and type-only stay distinct. */
	edges: readonly DependencyEdgeKind[];
	/** The full violation path for cycle violations, in the tool's reported order. */
	cycle: readonly string[];
}

/** One dependency exempted by an allowed boundary — visible evidence, never silently dropped. */
export interface AllowedDependency {
	/** The allowed boundary rule that exempted the dependency. */
	rule: string;
	from: string;
	to: string;
	specifier: string;
}

/** The normalized product of one validated cruise. */
export interface DependencyCruiserNormalizedEvidence {
	/** Namespaced metric values (`provider.dependency-cruiser.…`), unscored, sorted by id. */
	metrics: readonly MetricValue[];
	/** One namespaced finding per violation and per allowed dependency, deterministically ordered. */
	findings: readonly Finding[];
	/** The normalized violations (the findings' own payload, in evidence order). */
	violations: readonly NormalizedViolation[];
	/** The dependencies exempted by allowed boundaries, with the exempting rule. */
	allowedDependencies: readonly AllowedDependency[];
}

/** The tool's module-level location: findings need a range; the tool reports no lines. */
const MODULE_RANGE = { start: { line: 1 }, end: { line: 1 } } as const;

/** The edge flavors one reported dependency carries (`type-only` present ⇒ type-only, else runtime). */
function edgeFlavors(dependencyTypes: readonly string[]): DependencyEdgeKind[] {
	return dependencyTypes.includes("type-only") ? ["type-only"] : ["runtime"];
}

/** The compiled rule a violation names, or an operational error when the policy does not declare it. */
function ruleKindOf(
	policy: CompiledArchitecturePolicy,
	name: string,
): "boundary" | "cycle" | "unresolved" {
	for (const rule of policy.rules) {
		if (rule.name !== name) continue;
		if (rule.kind === "unresolved") return "unresolved";
		if (rule.kind === "cycle") return "cycle";
		return "boundary";
	}
	throw new InvalidDependencyCruiserEvidenceError(
		`violation names rule "${name}", which the compiled policy does not declare`,
	);
}

/** Whether an allowed boundary exempts one violation: its selectors match and its edges intersect the violation's. */
function exemptingRule(
	policy: CompiledArchitecturePolicy,
	violation: { from: string; to: string; edges: readonly DependencyEdgeKind[] },
): string | undefined {
	for (const rule of policy.rules) {
		if (rule.kind !== "boundary" || rule.allowance !== "allowed") continue;
		const from = new RegExp(rule.from);
		const to = new RegExp(rule.to);
		if (!from.test(violation.from) || !to.test(violation.to)) continue;
		if (rule.edges.some((edge) => violation.edges.includes(edge))) return rule.name;
	}
	return undefined;
}

/** The total order of normalized units: rule, then module, then target and specifier. */
function byNormalizedUnit(
	a: { rule: string; from: string; to: string; specifier?: string },
	b: { rule: string; from: string; to: string; specifier?: string },
): number {
	if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
	if (a.from !== b.from) return a.from < b.from ? -1 : 1;
	if (a.to !== b.to) return a.to < b.to ? -1 : 1;
	const aSpecifier = a.specifier ?? "";
	const bSpecifier = b.specifier ?? "";
	return aSpecifier < bSpecifier ? -1 : 1;
}

/** One finding for a normalized violation. */
function violationFinding(violation: NormalizedViolation): Finding {
	const target =
		violation.type === "cycle"
			? `cycle ${violation.cycle.length > 0 ? violation.cycle.join(" -> ") : violation.to}`
			: violation.type === "unresolved"
				? `unresolved import '${violation.specifier}'`
				: `imports ${violation.to}`;
	return {
		kind: namespacedEvidenceId(DEPENDENCY_CRUISER_PROVIDER_ID, violation.rule),
		path: violation.from,
		range: MODULE_RANGE,
		summary: `${violation.type} rule '${violation.rule}': ${violation.from} ${target}`,
		facts: {
			rule: violation.rule,
			violationType: violation.type,
			to: violation.to,
			specifier: violation.specifier,
			edges: [...violation.edges],
			...(violation.cycle.length === 0 ? {} : { cycle: [...violation.cycle] }),
		},
	};
}

/** One finding for an allowed dependency exempted by an allowed boundary. */
function allowedFinding(dependency: AllowedDependency): Finding {
	return {
		kind: namespacedEvidenceId(DEPENDENCY_CRUISER_PROVIDER_ID, "allowed-dependency"),
		path: dependency.from,
		range: MODULE_RANGE,
		summary:
			`allowed boundary '${dependency.rule}' exempts ${dependency.from} -> ${dependency.to} ` +
			`('${dependency.specifier}') from every forbidden boundary`,
		facts: {
			rule: dependency.rule,
			to: dependency.to,
			specifier: dependency.specifier,
		},
	};
}

/** Count one metric by id with a complete value and optional detail. */
function countMetric(name: string, value: number, detail?: Record<string, unknown>): MetricValue {
	return {
		id: namespacedEvidenceId(DEPENDENCY_CRUISER_PROVIDER_ID, name),
		state: "complete",
		value,
		unit: "count",
		...(detail === undefined ? {} : { detail }),
	};
}

/** The stub-class counts of the coverage account (builtins, externals, unresolved locals stay separate). */
function stubCounts(stubs: readonly { kind: string }[]): Record<string, number> {
	const counts: Record<string, number> = { builtin: 0, external: 0, "unresolved-local": 0 };
	for (const stub of stubs) {
		counts[stub.kind] = (counts[stub.kind] ?? 0) + 1;
	}
	return counts;
}

/** Normalize every reported violation into violations and allowed exemptions (see the module docblock). */
function normalizeViolations(
	report: RawDependencyCruiserReport,
	policy: CompiledArchitecturePolicy,
	selection: ReadonlySet<string>,
): { violations: NormalizedViolation[]; allowed: AllowedDependency[] } {
	const violations: NormalizedViolation[] = [];
	const allowed: AllowedDependency[] = [];
	for (const violation of report.summary.violations) {
		const normalized: NormalizedViolation = {
			rule: violation.rule.name,
			type: ruleKindOf(policy, violation.rule.name),
			from: violation.from,
			to: violation.to,
			specifier: violation.unresolvedTo ?? violation.to,
			edges: edgeFlavors(violation.dependencyTypes),
			cycle: violation.cycle?.map((member) => member.name) ?? [],
		};
		if (!selection.has(normalized.from)) {
			throw new InvalidDependencyCruiserEvidenceError(
				`violation of '${normalized.rule}' originates in "${normalized.from}", which is outside the staged selection`,
			);
		}
		const exempt = normalized.type === "boundary" ? exemptingRule(policy, normalized) : undefined;
		if (exempt !== undefined) {
			allowed.push({
				rule: exempt,
				from: normalized.from,
				to: normalized.to,
				specifier: normalized.specifier,
			});
			continue;
		}
		violations.push(normalized);
	}
	// Deterministic units: a reordered raw report normalizes to an identical result.
	violations.sort(byNormalizedUnit);
	allowed.sort(byNormalizedUnit);
	return { violations, allowed };
}

/** The local production-to-production edge account of the reported graph. */
function countLocalEdges(
	report: RawDependencyCruiserReport,
	selection: ReadonlySet<string>,
): { local: number; typeOnly: number; dynamic: number } {
	let local = 0;
	let typeOnly = 0;
	let dynamic = 0;
	for (const module of report.modules) {
		if (!selection.has(module.source)) continue;
		for (const dependency of module.dependencies) {
			if (!selection.has(dependency.resolved)) continue;
			local += 1;
			if (dependency.dependencyTypes.includes("type-only")) typeOnly += 1;
			if (dependency.dynamic) dynamic += 1;
		}
	}
	return { local, typeOnly, dynamic };
}

/** The namespaced metric set of one normalized cruise (see the module docblock). */
function normalizedMetrics(
	coverage: CruiseCoverage,
	violations: readonly NormalizedViolation[],
	allowed: readonly AllowedDependency[],
	edges: { local: number; typeOnly: number; dynamic: number },
): MetricValue[] {
	const perRule: Record<string, number> = {};
	for (const violation of violations) {
		perRule[violation.rule] = (perRule[violation.rule] ?? 0) + 1;
	}
	const isFullyAsserted = coverage.missingFiles.length === 0;
	const nodesMetric: MetricValue = {
		id: namespacedEvidenceId(DEPENDENCY_CRUISER_PROVIDER_ID, "graph.nodes"),
		state: isFullyAsserted ? "complete" : "incomplete",
		value: coverage.representedFiles.length,
		unit: "count",
		...(isFullyAsserted ? {} : { reason: missingFilesReason(coverage) }),
	};
	return [
		nodesMetric,
		countMetric("graph.stubs", coverage.stubs.length, { classes: stubCounts(coverage.stubs) }),
		countMetric("graph.edges", edges.local, { typeOnly: edges.typeOnly, dynamic: edges.dynamic }),
		countMetric("violations", violations.length, { byRule: perRule }),
		countMetric("allowed-dependencies", allowed.length),
	].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The deterministic finding order: kind, then module, then summary. */
function byFinding(a: Finding, b: Finding): number {
	if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
	if (a.path !== b.path) return a.path < b.path ? -1 : 1;
	return a.summary < b.summary ? -1 : 1;
}

/**
 * Normalize one validated raw report over its cruise coverage against the
 * compiled policy it evaluated (see the module docblock for the exact
 * violation, exception and stub semantics). Deterministic: a reordered raw
 * report over the same policy normalizes to an identical result.
 */
export function normalizeDependencyCruiserReport(
	report: RawDependencyCruiserReport,
	policy: CompiledArchitecturePolicy,
	coverage: CruiseCoverage,
	selectionPaths: readonly string[],
): DependencyCruiserNormalizedEvidence {
	const selection = new Set(selectionPaths);
	const { violations, allowed } = normalizeViolations(report, policy, selection);
	const edges = countLocalEdges(report, selection);
	const findings: Finding[] = [
		...violations.map(violationFinding),
		...allowed.map(allowedFinding),
	].sort(byFinding);
	return {
		metrics: normalizedMetrics(coverage, violations, allowed, edges),
		findings,
		violations,
		allowedDependencies: allowed,
	};
}
