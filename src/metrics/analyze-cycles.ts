/**
 * Import-cycle analysis over the resolved dependency graph (SPEC §5.4,
 * trellis-cbde).
 *
 * {@link analyzeCycles} consumes the {@link DependencyGraphAnalysis} of
 * trellis-d214 and reports **complete cyclic module groups** (strongly
 * connected components, never first-cycle-only) under the versioned
 * {@link CYCLE_POLICY}:
 *
 * - groups carry their edge class (`runtime` / `type-only` — computed over
 *   separate subgraphs and scored separately), sorted members, the touched
 *   packages, and a deterministic representative path;
 * - per-package views list the groups touching each package by shared id —
 *   cross-package cycles appear in every affected package's view while
 *   module counts stay per-package, so the repo-level affected-module total
 *   (the union over all groups) never double-counts;
 * - contract metrics `import-cycle.groups` (count, split by class in
 *   `detail`), `import-cycle.modules` (affected-module union), and
 *   `import-cycle.density` (affected modules / graph nodes, a ratio of
 *   compatible quantities), plus one located `import-cycle` finding per
 *   group.
 *
 * State rules (SPEC §3.3):
 *
 * - Counts are always finite (`0` when acyclic) → `complete` on a complete
 *   graph. The density is `not-applicable` only for a node-free graph
 *   (a 0/0 ratio is meaningless).
 * - Unresolved graph coverage accompanies the results: when the dependency
 *   graph is `incomplete` (unresolved edges or parse diagnostics), every
 *   cycle metric is `incomplete` with the partial values measured over the
 *   resolved edges and a reason carrying the graph's own incompleteness
 *   reasons; `detail.unresolvedEdges` keeps the unresolved-edge count
 *   machine-readable. An incomplete graph never yields an apparently clean
 *   cycle result.
 *
 * Determinism (SPEC §3.5): group ids and representative paths derive from
 * sorted members and sorted adjacency only, so the analysis is byte-stable
 * across filesystem enumeration order. The analysis never reads files and
 * never scores.
 */
import type { Finding, MetricValue, Range } from "../contract/index.ts";
import {
	CYCLE_POLICY_VERSION,
	compareStrings,
	detectClassGroups,
	type EdgeClass,
} from "./cycles.ts";
import { roundTo } from "./erosion.ts";
import type { DependencyGraph, DependencyGraphAnalysis } from "./graph-types.ts";

/** One complete cyclic module group (SPEC §5.4). */
export interface CycleGroup {
	/** Stable `cycle-<n>` id in (smallest member, edge class) order. */
	id: string;
	/** The edge subgraph the group is cyclic in; classes are scored separately. */
	edgeClass: EdgeClass;
	/** Member module paths, sorted lexicographically. */
	members: string[];
	/** Distinct packages the members belong to, sorted. */
	packages: string[];
	/** A concrete cycle within the group; first element equals the last. */
	representativePath: string[];
}

/** One package's cycle view; cross-package groups share their id across views. */
export interface PackageCycleView {
	packagePath: string;
	/** Classified modules in the package (the per-package denominator). */
	modules: number;
	/** Modules of this package in any cyclic group (never double-counted). */
	affectedModules: number;
	/** Ids of the groups touching this package, in group order. */
	groups: string[];
}

/** The cycle measurement of one audit: groups, package views, metrics, findings. */
export interface CycleAnalysis {
	/** {@link CYCLE_POLICY_VERSION} the measurement ran under. */
	policyVersion: string;
	/** Every cyclic module group, in id order (both edge classes). */
	groups: CycleGroup[];
	/** One view per package touched by at least one group, sorted by path. */
	packages: PackageCycleView[];
	/** Repo-level affected modules: the union over all groups (no double-counting). */
	affectedModules: number;
	/** Contract metric values (SPEC §6.1), sorted by id. */
	metrics: MetricValue[];
	/** One `import-cycle` finding per group, in id order. */
	findings: Finding[];
}

/** Affected-module counts: repo union plus per-class unions. */
interface AffectedModules {
	all: number;
	runtime: number;
	typeOnly: number;
}

/** Detect both classes' raw groups and assign stable ids + package lists. */
function buildGroups(graph: DependencyGraph): CycleGroup[] {
	const raws = (["runtime", "type-only"] as const).flatMap((edgeClass) =>
		detectClassGroups(graph, edgeClass),
	);
	raws.sort(
		(a, b) =>
			compareStrings(a.members[0] ?? "", b.members[0] ?? "") ||
			compareStrings(a.edgeClass, b.edgeClass),
	);
	const packageOf = new Map(graph.nodes.map((node) => [node.path, node.packagePath]));
	return raws.map((raw, index) => ({
		id: `cycle-${index + 1}`,
		edgeClass: raw.edgeClass,
		members: raw.members,
		packages: [...new Set(raw.members.map((member) => packageOf.get(member) ?? ""))].sort(
			compareStrings,
		),
		representativePath: raw.representativePath,
	}));
}

/** Union counts: each module counts once overall and once per class. */
function countAffected(groups: readonly CycleGroup[]): AffectedModules {
	const byClass = (edgeClass: EdgeClass) =>
		new Set(
			groups.filter((group) => group.edgeClass === edgeClass).flatMap((group) => group.members),
		).size;
	return {
		all: new Set(groups.flatMap((group) => group.members)).size,
		runtime: byClass("runtime"),
		typeOnly: byClass("type-only"),
	};
}

/** Per-package views; only packages touched by at least one group appear. */
function packageViews(graph: DependencyGraph, groups: readonly CycleGroup[]): PackageCycleView[] {
	const totals = new Map<string, number>();
	const packageOf = new Map<string, string>();
	for (const node of graph.nodes) {
		totals.set(node.packagePath, (totals.get(node.packagePath) ?? 0) + 1);
		packageOf.set(node.path, node.packagePath);
	}
	const affected = new Map<string, Set<string>>();
	const groupIds = new Map<string, string[]>();
	for (const group of groups) {
		for (const pkg of group.packages) {
			const ids = groupIds.get(pkg) ?? [];
			ids.push(group.id);
			groupIds.set(pkg, ids);
		}
		for (const member of group.members) {
			const pkg = packageOf.get(member) ?? "";
			const set = affected.get(pkg) ?? new Set<string>();
			set.add(member);
			affected.set(pkg, set);
		}
	}
	return [...groupIds.keys()].sort(compareStrings).map((pkg) => ({
		packagePath: pkg,
		modules: totals.get(pkg) ?? 0,
		affectedModules: affected.get(pkg)?.size ?? 0,
		groups: groupIds.get(pkg) ?? [],
	}));
}

/** The shared incompleteness reason, when the underlying graph is incomplete (SPEC §3.3). */
function graphIncompleteness(analysis: DependencyGraphAnalysis): string | undefined {
	if (analysis.graph.completeness !== "incomplete") return undefined;
	const reasons = analysis.metrics.flatMap((metric) =>
		metric.state === "incomplete" && metric.reason !== undefined ? [metric.reason] : [],
	);
	const distinct = [...new Set(reasons)];
	return distinct.length === 0
		? "the dependency graph is incomplete"
		: `dependency graph incomplete: ${distinct.join("; ")}`;
}

/** State + partial value under the documented state rules. */
function stateAndValue(
	value: number,
	reason: string | undefined,
): Pick<MetricValue, "state" | "value" | "reason"> {
	return reason === undefined
		? { state: "complete", value }
		: { state: "incomplete", value, reason };
}

/** The density over the compatible denominator (graph nodes). */
function densityMetric(nodes: number, affected: number, reason: string | undefined): MetricValue {
	if (nodes === 0) {
		return { id: "import-cycle.density", unit: "ratio", state: "not-applicable" };
	}
	return {
		id: "import-cycle.density",
		unit: "ratio",
		...stateAndValue(roundTo(affected / nodes, 6), reason),
		numerator: affected,
		denominator: nodes,
	};
}

/** Emit the cycle metric set (ids sorted by the caller). */
function cycleMetrics(
	graph: DependencyGraph,
	groups: readonly CycleGroup[],
	affected: AffectedModules,
	reason: string | undefined,
): MetricValue[] {
	const runtime = groups.filter((group) => group.edgeClass === "runtime").length;
	const unresolvedEdges = graph.edges.filter(
		(edge) => edge.resolution.status === "unresolved",
	).length;
	const metrics: MetricValue[] = [
		{
			id: "import-cycle.groups",
			unit: "count",
			...stateAndValue(groups.length, reason),
			detail: {
				runtime,
				typeOnly: groups.length - runtime,
				policyVersion: CYCLE_POLICY_VERSION,
				unresolvedEdges,
			},
		},
		{
			id: "import-cycle.modules",
			unit: "count",
			...stateAndValue(affected.all, reason),
			detail: { runtime: affected.runtime, typeOnly: affected.typeOnly },
		},
		densityMetric(graph.nodes.length, affected.all, reason),
	];
	return metrics.sort((a, b) => compareStrings(a.id, b.id));
}

/** The range locating a group: the first edge of its representative path. */
function findingRange(graph: DependencyGraph, group: CycleGroup): Range {
	const from = group.representativePath[0] ?? "";
	const to = group.representativePath[1] ?? from;
	const edge = graph.edges.find(
		(candidate) =>
			candidate.from === from &&
			candidate.typeOnly === (group.edgeClass === "type-only") &&
			candidate.resolution.status === "local" &&
			candidate.resolution.target === to,
	);
	return edge?.range ?? { start: { line: 1 }, end: { line: 1 } };
}

/** One `import-cycle` finding per group (SPEC §6.2). */
function cycleFinding(graph: DependencyGraph, group: CycleGroup): Finding {
	return {
		kind: "import-cycle",
		path: group.representativePath[0] ?? "",
		range: findingRange(graph, group),
		summary: `${group.edgeClass} import cycle over ${group.members.length} module(s): ${group.representativePath.join(" → ")}`,
		facts: {
			group: group.id,
			edgeClass: group.edgeClass,
			members: group.members.length,
			packages: group.packages,
			representativePath: group.representativePath,
		},
	};
}

/**
 * Measure the import cycles of a resolved dependency graph (see the module
 * docblock for the outputs and state rules). Pure function of the analysis:
 * never reads files, never re-parses, never scores.
 */
export function analyzeCycles(analysis: DependencyGraphAnalysis): CycleAnalysis {
	const { graph } = analysis;
	const groups = buildGroups(graph);
	const affected = countAffected(groups);
	const reason = graphIncompleteness(analysis);
	return {
		policyVersion: CYCLE_POLICY_VERSION,
		groups,
		packages: packageViews(graph, groups),
		affectedModules: affected.all,
		metrics: cycleMetrics(graph, groups, affected, reason),
		findings: groups.map((group) => cycleFinding(graph, group)),
	};
}
