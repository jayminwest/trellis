/**
 * Dependency-graph contract and the **versioned graph policy** (SPEC §5.4,
 * trellis-d214).
 *
 * The dependency graph is the resolved, typed import structure of the audited
 * workspace: every classified TS/TSX file is a {@link GraphNode}; every import
 * site discovered in the shared parse is a {@link GraphEdge} whose
 * {@link EdgeResolution} records exactly what the specifier resolved to — a
 * local file, an out-of-scope file, an external package, or a documented
 * unresolved outcome. Cycle measurement (trellis-cbde) and scoring
 * (trellis-00d5) consume this graph; construction itself never scores.
 *
 * Documented rules (binding on all consumers):
 *
 * - **Edges are typed.** `import type` / `export type … from` / type-position
 *   `import("…")` produce `typeOnly: true` edges that keep their identity and
 *   are never merged with runtime edges. Whether they are *scored* separately
 *   is fixed by {@link GRAPH_POLICY} (`typeOnlyEdges: "retained-distinct"`) —
 *   the graph always carries the distinction.
 * - **Edge kinds.** `import` (static imports, TS import-equals, and
 *   type-position import types), `re-export` (`export … from`, `export *`),
 *   and `dynamic` (value-position `import("…")` call expressions) are
 *   distinct kinds. CommonJS `require(…)` calls are **not** recorded (the
 *   audit scope is TS/ESM source; a require-only dependency surface is
 *   visible as the absence of edges, never forged).
 * - **Self-edges are retained.** A file importing itself records a `local`
 *   edge whose `target` equals `from`; cycle policy downstream
 *   (trellis-cbde) decides what a self-edge means.
 * - **Externals are never resolved into.** Bare specifiers that are neither
 *   tsconfig aliases nor local workspace packages are `external` edges
 *   recorded by package name. Resolution uses local files and configuration
 *   only — `node_modules` is never consulted, so absent dependencies change
 *   nothing (SPEC §8: no fetch, no probe, no install-state dependence).
 * - **Unresolved local intent is surfaced.** A relative specifier, a matched
 *   tsconfig path mapping, or a workspace-package specifier that fails to
 *   resolve is an `unresolved` edge with a machine-checkable
 *   {@link UnresolvedReason} — distinguishable from externals, and rolled up
 *   as `incomplete` coverage (SPEC §3.3). A non-literal dynamic import is
 *   recorded the same way but is opaque rather than incomplete: no static
 *   resolver can ever resolve it (policy 1.1.0).
 */
import type { Completeness, Finding, MetricValue, Range, SourceSet } from "../contract/index.ts";

/** The versioned graph policy (SPEC §5.4 "fixed by the (versioned) graph policy"). */
export const GRAPH_POLICY_VERSION = "1.1.0";

export const GRAPH_POLICY = {
	version: GRAPH_POLICY_VERSION,
	/** Type-only edges keep their identity and are never merged with runtime edges. */
	typeOnlyEdges: "retained-distinct",
	/** Only string-literal dynamic imports become edges; non-literal specifiers are unresolved. */
	dynamicImports: "literal-only",
	/**
	 * Non-literal `import(expr)` sites are recorded as unresolved edges with a
	 * finding, but are statically unknowable — they never make the graph (or
	 * cycle analysis of the literal graph) incomplete. 1.1.0, trellis-42ad;
	 * 1.0.0 counted them as incompleteness.
	 */
	nonLiteralDynamicImports: "recorded-opaque",
	/** A file importing itself records a self-edge; cycle policy downstream decides its meaning. */
	selfEdges: "retained",
	/** External packages are recorded by name and never resolved into (local files/config only). */
	externalPackages: "recorded-never-resolved",
} as const;

export type GraphPolicy = typeof GRAPH_POLICY;

/** The syntactic kind of an import site. */
export type EdgeKind = "import" | "re-export" | "dynamic";

/**
 * Why a local-intent specifier did not resolve. Machine-checkable; the
 * edge's `resolution.reason` text carries the human-readable detail.
 */
export type UnresolvedReason =
	/** Relative/alias/workspace specifier matched no file on disk. */
	| "no-target"
	/** The specifier resolved above the audited root. */
	| "outside-root"
	/** The workspace package's `exports` map has no matching entry. */
	| "exports-encapsulation"
	/** The `exports` shape exceeds the documented supported subset. */
	| "unsupported-exports"
	/** `import(expr)` where `expr` is not a string literal. */
	| "non-literal-dynamic";

/** What one import specifier resolved to. */
export type EdgeResolution =
	/** Resolved to a file in the audited inventory (an intra-workspace graph edge). */
	| { status: "local"; target: string }
	/**
	 * Resolved to a real file outside the classified scope (excluded build
	 * output, a non-TS sibling, an ignored dependency dir). Recorded with its
	 * repo-relative target; never a graph node.
	 */
	| { status: "out-of-scope"; target: string }
	/** A bare specifier naming a package outside the local workspace (never resolved into). */
	| { status: "external"; packageName: string }
	/** Local intent that failed to resolve (see {@link UnresolvedReason}). */
	| { status: "unresolved"; reason: UnresolvedReason; detail: string };

/** One import site in one file, resolved (SPEC §5.4). */
export interface GraphEdge {
	/** Repo-relative POSIX path of the importing file. */
	from: string;
	kind: EdgeKind;
	/** True for `import type` / `export type … from` / type-position `import("…")`. */
	typeOnly: boolean;
	/** The specifier as written; `null` only for non-literal dynamic imports. */
	specifier: string | null;
	/** 1-based range of the specifier (of the argument expression when non-literal). */
	range: Range;
	resolution: EdgeResolution;
}

/** Every classified file is a node, in the syntax inventory's (sorted) order. */
export interface GraphNode {
	/** Repo-relative POSIX path. */
	path: string;
	packagePath: string;
	sourceSet: SourceSet;
}

/** A tsconfig consulted during resolution (traceability of alias behavior). */
export interface GraphConfig {
	/** Repo-relative POSIX path of the `tsconfig.json`. */
	path: string;
	/** `unreadable` configs contribute no options; their aliases simply never fire. */
	status: "parsed" | "unreadable";
}

/** One external package named by at least one edge. */
export interface ExternalPackage {
	name: string;
	edges: number;
}

/** The resolved, typed dependency graph of one audit (SPEC §5.4). */
export interface DependencyGraph {
	/** {@link GRAPH_POLICY_VERSION} the graph was built under. */
	policyVersion: string;
	/** Absolute audited root. */
	root: string;
	/** One node per classified file, in inventory (sorted) order. */
	nodes: GraphNode[];
	/**
	 * Every import site of every node, grouped by importer in node order and
	 * in source order within a file — stable across filesystem enumeration.
	 */
	edges: GraphEdge[];
	/** Distinct external packages, sorted by name. */
	externals: ExternalPackage[];
	/** Tsconfigs consulted for alias resolution, sorted by path. */
	configs: GraphConfig[];
	/** `"incomplete"` when resolvable edges are unresolved or files carried parse diagnostics (SPEC §3.3). */
	completeness: Completeness;
}

/** The graph plus its contract metrics and findings. */
export interface DependencyGraphAnalysis {
	graph: DependencyGraph;
	/** Contract metric values (SPEC §6.1), sorted by id. */
	metrics: MetricValue[];
	/** One `graph.unresolved-import` finding per unresolved edge, in edge order. */
	findings: Finding[];
}
