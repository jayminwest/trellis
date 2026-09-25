/**
 * Dependency-graph analysis over the shared syntax inventory (SPEC §5.4,
 * trellis-d214).
 *
 * {@link analyzeDependencyGraph} resolves every import site of every
 * classified file ({@link collectImportSites} over the one shared parse;
 * {@link createGraphResolver} over local files/configuration only) into the
 * typed, versioned {@link DependencyGraph} — the graph foundation cycle
 * measurement (trellis-cbde) consumes.
 *
 * Contract outputs:
 *
 * - `graph.files` — node count (every classified file), always `complete`.
 * - `graph.edges.local` — resolved intra-workspace edges; `detail` splits
 *   them by kind and `typeOnly` and counts `out-of-scope` edges (resolved to
 *   real files outside the classified scope).
 * - `graph.edges.external` — external-package edges; `detail` counts the
 *   distinct packages. Externals are recorded, never resolved into
 *   (versioned policy `externalPackages: "recorded-never-resolved"`).
 * - `graph.edges.unresolved` — local-intent edges that failed to resolve;
 *   `incomplete` with the count and a reason when non-zero (SPEC §3.3:
 *   unresolved imports are an incompleteness cause). Non-literal dynamic
 *   imports (`import(expr)`) are counted here and in
 *   `detail.nonLiteralDynamic` but are **opaque, not incomplete** under
 *   graph policy 1.1.0: no static analysis can ever resolve them, so they
 *   never invalidate the literal graph (trellis-42ad).
 *
 * State rules (SPEC §3.3 — the existing analyzer pattern): files with parse
 * diagnostics may hide import sites, so their presence makes every edge
 * metric `incomplete` with partial values and a reason naming the affected
 * file count; `graph.files` stays `complete` (the nodes are known).
 *
 * One `graph.unresolved-import` finding per unresolved edge carries the exact
 * location, specifier, kind, and machine-checkable reason. Determinism:
 * nodes follow the (sorted) inventory, edges follow source order within each
 * file, and every aggregate is sorted — same tree in ⇒ byte-equal graph out
 * (SPEC §3.5).
 */
import type { Finding, MetricValue } from "../contract/index.ts";
import type { SourceInventory } from "../discovery/index.ts";
import type { SyntaxInventory } from "../syntax/index.ts";
import { collectImportSites } from "./graph-imports.ts";
import { createGraphResolver } from "./graph-resolve.ts";
import {
	type DependencyGraph,
	type DependencyGraphAnalysis,
	type ExternalPackage,
	GRAPH_POLICY_VERSION,
	type GraphEdge,
} from "./graph-types.ts";

/** Count edges by one predicate. */
function countBy(edges: readonly GraphEdge[], keep: (edge: GraphEdge) => boolean): number {
	return edges.filter(keep).length;
}

/** Distinct external packages with edge counts, sorted by name. */
function externalPackages(edges: readonly GraphEdge[]): ExternalPackage[] {
	const counts = new Map<string, number>();
	for (const edge of edges) {
		if (edge.resolution.status === "external") {
			const name = edge.resolution.packageName;
			counts.set(name, (counts.get(name) ?? 0) + 1);
		}
	}
	return [...counts.entries()]
		.map(([name, edgeCount]) => ({ name, edges: edgeCount }))
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The shared incompleteness reason, when any (SPEC §3.3). */
function incompletenessReason(unresolved: number, diagnosticFiles: number): string | undefined {
	const parts: string[] = [];
	if (unresolved > 0) {
		parts.push(`${unresolved} local import edge(s) could not be resolved`);
	}
	if (diagnosticFiles > 0) {
		parts.push(
			`${diagnosticFiles} file(s) produced parse diagnostics; their imports may be missing`,
		);
	}
	return parts.length === 0 ? undefined : parts.join("; ");
}

/** One metric's state + optional value under the documented state rules. */
function stateAndValue(
	value: number,
	reason: string | undefined,
): Pick<MetricValue, "state" | "value" | "reason"> {
	return reason === undefined
		? { state: "complete", value }
		: { state: "incomplete", value, reason };
}

/**
 * A non-literal dynamic import: statically unknowable by construction, so it
 * is recorded (edge + finding) but never an incompleteness cause
 * (`GRAPH_POLICY.nonLiteralDynamicImports`, trellis-42ad).
 */
function isOpaqueEdge(edge: GraphEdge): boolean {
	return (
		edge.resolution.status === "unresolved" && edge.resolution.reason === "non-literal-dynamic"
	);
}

/** Emit the graph metric set (ids sorted by the caller). */
function graphMetrics(graph: DependencyGraph, diagnosticFiles: number): MetricValue[] {
	const edges = graph.edges;
	const unresolved = countBy(edges, (edge) => edge.resolution.status === "unresolved");
	const nonLiteralDynamic = countBy(edges, isOpaqueEdge);
	const localReason = incompletenessReason(0, diagnosticFiles);
	const unresolvedReason = incompletenessReason(unresolved - nonLiteralDynamic, diagnosticFiles);
	const local = edges.filter((edge) => edge.resolution.status === "local");
	const metrics: MetricValue[] = [
		{ id: "graph.files", unit: "count", state: "complete", value: graph.nodes.length },
		{
			id: "graph.edges.local",
			unit: "count",
			...stateAndValue(local.length, localReason),
			detail: {
				typeOnly: countBy(local, (edge) => edge.typeOnly),
				reExports: countBy(local, (edge) => edge.kind === "re-export"),
				dynamic: countBy(local, (edge) => edge.kind === "dynamic"),
				outOfScope: countBy(edges, (edge) => edge.resolution.status === "out-of-scope"),
			},
		},
		{
			id: "graph.edges.external",
			unit: "count",
			...stateAndValue(
				countBy(edges, (edge) => edge.resolution.status === "external"),
				localReason,
			),
			detail: { packages: graph.externals.length },
		},
		{
			id: "graph.edges.unresolved",
			unit: "count",
			...stateAndValue(unresolved, unresolvedReason),
			detail: { policyVersion: graph.policyVersion, nonLiteralDynamic },
		},
	];
	return metrics.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** One `graph.unresolved-import` finding per unresolved edge (SPEC §6.2). */
function unresolvedFindings(edges: readonly GraphEdge[]): Finding[] {
	const findings: Finding[] = [];
	for (const edge of edges) {
		if (edge.resolution.status !== "unresolved") continue;
		const { reason, detail } = edge.resolution;
		findings.push({
			kind: "graph.unresolved-import",
			path: edge.from,
			range: edge.range,
			summary: `unresolved ${edge.kind} '${edge.specifier ?? "(non-literal)"}': ${detail}`,
			facts: {
				specifier: edge.specifier,
				edgeKind: edge.kind,
				typeOnly: edge.typeOnly,
				reason,
			},
		});
	}
	return findings;
}

/**
 * Resolve the workspace's dependency graph (see the module docblock for the
 * outputs and state rules). Resolution touches local files/configuration
 * only — never the network, never `node_modules`.
 */
export function analyzeDependencyGraph(
	source: SourceInventory,
	syntax: SyntaxInventory,
): DependencyGraphAnalysis {
	const resolver = createGraphResolver(source);
	const edges: GraphEdge[] = syntax.files.flatMap((file) =>
		collectImportSites(file.sourceFile).map((site) => ({
			from: file.path,
			kind: site.kind,
			typeOnly: site.typeOnly,
			specifier: site.specifier,
			range: site.range,
			resolution: resolver.resolve(file.path, site),
		})),
	);
	const diagnosticFiles = syntax.files.filter((file) => file.diagnostics.length > 0).length;
	const graph: DependencyGraph = {
		policyVersion: GRAPH_POLICY_VERSION,
		root: syntax.root,
		nodes: syntax.files.map((file) => ({
			path: file.path,
			packagePath: file.packagePath,
			sourceSet: file.sourceSet,
		})),
		edges,
		externals: externalPackages(edges),
		configs: resolver.configs(),
		completeness: "complete",
	};
	const metrics = graphMetrics(graph, diagnosticFiles);
	graph.completeness = metrics.some((metric) => metric.state === "incomplete")
		? "incomplete"
		: "complete";
	return { graph, metrics, findings: unresolvedFindings(edges) };
}
