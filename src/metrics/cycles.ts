/**
 * Import-cycle measurement core: complete cyclic module groups over the
 * resolved dependency graph (SPEC §5.4 "Cycle measurement", trellis-cbde).
 *
 * This module replaces first-cycle-only detection with **strongly connected
 * components**: every module that sits on any cycle lands in exactly one
 * group per edge class, so overlapping cycles merge into their complete
 * group and disjoint cycles stay separate. No architecture boundary rules
 * are added — the measurement reports what is cyclic, never what may import
 * what.
 *
 * The versioned {@link CYCLE_POLICY} fixes the documented outcomes:
 *
 * - **Edge classes.** Runtime and type-only edges form two *separate*
 *   subgraphs; a pair linked runtime one way and type-only the other is not
 *   a cycle in either. A module group cyclic in both classes appears once
 *   per class, and the classes are **scored separately** (the scorer,
 *   trellis-00d5, weights them — measurement only keeps them distinct).
 * - **Self-imports.** A retained self-edge (graph policy `selfEdges:
 *   "retained"`) is a size-1 cyclic group whose representative path is
 *   `[p, p]`.
 * - **Stable identity.** Group ids (`cycle-<n>`) follow (smallest member,
 *   edge class) sort order, and the representative path is the shortest
 *   cycle from the group's lexicographically smallest member over sorted
 *   adjacency (ties break lexicographically) — byte-stable across
 *   filesystem enumeration order.
 * - **Package views.** Cross-package groups carry one id listed in every
 *   touched package's view; module counts stay per-package (each module
 *   belongs to exactly one package), so repo totals never double-count.
 *
 * Everything here is a pure function of the {@link DependencyGraph}: same
 * graph in ⇒ byte-equal groups out (SPEC §3.5).
 */
import type { DependencyGraph } from "./graph-types.ts";

/** The versioned cycle policy (SPEC §5.4 "fixed by the (versioned) graph policy"). */
export const CYCLE_POLICY_VERSION = "1.0.0";

export const CYCLE_POLICY = {
	version: CYCLE_POLICY_VERSION,
	/**
	 * Runtime and type-only edges form separate subgraphs; groups keep their
	 * class and the two classes are scored separately (weighted downstream).
	 */
	edgeClasses: "runtime-and-type-only-separate",
	/** A self-import is a size-1 cyclic group whose representative path is `[p, p]`. */
	selfEdges: "size-1-groups",
	/**
	 * Ids `cycle-<n>` follow (smallest member, class) order; the representative
	 * path is the shortest cycle from the smallest member over sorted adjacency.
	 */
	identity: "sorted-members-shortest-path",
	/**
	 * Cross-package groups keep one id across package views; module counts stay
	 * per-package so repo totals never double-count a cross-package group.
	 */
	packageView: "shared-ids-per-package-modules",
} as const;

export type CyclePolicy = typeof CYCLE_POLICY;

/** The edge subgraph a cycle group lives in. */
export type EdgeClass = "runtime" | "type-only";

/** One class's cyclic group before id assignment. */
export interface RawCycleGroup {
	edgeClass: EdgeClass;
	/** Member module paths, sorted lexicographically. */
	members: string[];
	/** A concrete cycle within the group: first element equals the last. */
	representativePath: string[];
}

/** Deterministic string comparison (code-unit order). */
export function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Sorted adjacency over `nodes`; duplicate edges collapse. */
export function buildAdjacency(
	nodes: readonly string[],
	edges: readonly { from: string; to: string }[],
): Map<string, string[]> {
	const targets = new Map<string, Set<string>>();
	for (const node of nodes) targets.set(node, new Set());
	for (const edge of edges) targets.get(edge.from)?.add(edge.to);
	const adjacency = new Map<string, string[]>();
	for (const [node, set] of targets) adjacency.set(node, [...set].sort(compareStrings));
	return adjacency;
}

/** Mutable state for the iterative Tarjan walk. */
interface TarjanState {
	adjacency: ReadonlyMap<string, readonly string[]>;
	indexOf: Map<string, number>;
	lowlink: Map<string, number>;
	onStack: Set<string>;
	stack: string[];
	nextIndex: number;
	components: string[][];
}

/** Assign the next DFS index to `node` and push it. */
function pushNode(state: TarjanState, node: string): void {
	state.indexOf.set(node, state.nextIndex);
	state.lowlink.set(node, state.nextIndex);
	state.nextIndex += 1;
	state.stack.push(node);
	state.onStack.add(node);
}

/** Propagate the lowlink to the parent and extract a rooted component. */
function settleNode(state: TarjanState, node: string, parent: string | undefined): void {
	if (parent !== undefined) {
		const low = Math.min(state.lowlink.get(parent) ?? 0, state.lowlink.get(node) ?? 0);
		state.lowlink.set(parent, low);
	}
	if (state.lowlink.get(node) !== state.indexOf.get(node)) return;
	const component: string[] = [];
	for (;;) {
		const member = state.stack.pop();
		if (member === undefined) break;
		state.onStack.delete(member);
		component.push(member);
		if (member === node) break;
	}
	state.components.push(component.sort(compareStrings));
}

/** Deepen or retire the top DFS frame (iterative Tarjan step). */
function stepFrame(state: TarjanState, frames: { node: string; child: number }[]): void {
	const frame = frames[frames.length - 1];
	if (frame === undefined) return;
	const targets = state.adjacency.get(frame.node) ?? [];
	if (frame.child >= targets.length) {
		frames.pop();
		settleNode(state, frame.node, frames[frames.length - 1]?.node);
		return;
	}
	const target = targets[frame.child];
	frame.child += 1;
	if (target === undefined) return;
	if (!state.indexOf.has(target)) {
		pushNode(state, target);
		frames.push({ node: target, child: 0 });
	} else if (state.onStack.has(target)) {
		const low = Math.min(state.lowlink.get(frame.node) ?? 0, state.indexOf.get(target) ?? 0);
		state.lowlink.set(frame.node, low);
	}
}

/** DFS from one not-yet-visited root. */
function visitFrom(state: TarjanState, root: string): void {
	pushNode(state, root);
	const frames: { node: string; child: number }[] = [{ node: root, child: 0 }];
	while (frames.length > 0) stepFrame(state, frames);
}

/**
 * All strongly connected components, each sorted, sorted by first member.
 * Nodes and adjacency are (re)sorted internally, so the result is stable
 * across input enumeration order. Singletons are included; the caller
 * decides which are cyclic.
 */
export function stronglyConnectedComponents(
	nodes: readonly string[],
	adjacency: ReadonlyMap<string, readonly string[]>,
): string[][] {
	const state: TarjanState = {
		adjacency,
		indexOf: new Map(),
		lowlink: new Map(),
		onStack: new Set(),
		stack: [],
		nextIndex: 0,
		components: [],
	};
	for (const node of [...nodes].sort(compareStrings)) {
		if (!state.indexOf.has(node)) visitFrom(state, node);
	}
	return state.components.sort((a, b) => compareStrings(a[0] ?? "", b[0] ?? ""));
}

/** Reconstruct `start → … → end` from BFS predecessors, closed back to `start`. */
function tracePath(predecessor: ReadonlyMap<string, string>, start: string, end: string): string[] {
	const chain: string[] = [];
	let current: string | undefined = end;
	while (current !== undefined && current !== start) {
		chain.unshift(current);
		current = predecessor.get(current);
	}
	return [start, ...chain, start];
}

/** One BFS level from `node`; returns the closed path when `start` is reached. */
function bfsStep(
	start: string,
	node: string,
	members: ReadonlySet<string>,
	adjacency: ReadonlyMap<string, readonly string[]>,
	predecessor: Map<string, string>,
	queue: string[],
): string[] | null {
	for (const target of adjacency.get(node) ?? []) {
		if (!members.has(target)) continue;
		if (target === start) return tracePath(predecessor, start, node);
		if (!predecessor.has(target)) {
			predecessor.set(target, node);
			queue.push(target);
		}
	}
	return null;
}

/**
 * The representative cycle of one group: a self-loop when present, else the
 * shortest cycle from `start` (the group's smallest member) over sorted
 * adjacency restricted to the group — deterministic, ties break
 * lexicographically.
 */
export function representativeCycle(
	start: string,
	members: ReadonlySet<string>,
	adjacency: ReadonlyMap<string, readonly string[]>,
): string[] {
	const startTargets = (adjacency.get(start) ?? []).filter((target) => members.has(target));
	if (startTargets.includes(start)) return [start, start];
	const predecessor = new Map<string, string>();
	const queue: string[] = [];
	for (const target of startTargets) {
		if (!predecessor.has(target)) {
			predecessor.set(target, start);
			queue.push(target);
		}
	}
	for (let head = 0; head < queue.length; head += 1) {
		const node = queue[head];
		if (node === undefined) break;
		const found = bfsStep(start, node, members, adjacency, predecessor, queue);
		if (found !== null) return found;
	}
	// Unreachable for a genuinely cyclic component: a path back to start exists.
	return [start];
}

/**
 * The cyclic groups of one edge class over the graph's resolved local edges
 * (an SCC of size &gt; 1, or a singleton carrying a self-edge).
 */
export function detectClassGroups(graph: DependencyGraph, edgeClass: EdgeClass): RawCycleGroup[] {
	const typeOnly = edgeClass === "type-only";
	const pairs = graph.edges.flatMap((edge) =>
		edge.typeOnly === typeOnly && edge.resolution.status === "local"
			? [{ from: edge.from, to: edge.resolution.target }]
			: [],
	);
	const selfLoops = new Set(pairs.filter((pair) => pair.from === pair.to).map((pair) => pair.from));
	const nodes = graph.nodes.map((node) => node.path);
	const adjacency = buildAdjacency(nodes, pairs);
	const groups: RawCycleGroup[] = [];
	for (const component of stronglyConnectedComponents(nodes, adjacency)) {
		const first = component[0] ?? "";
		if (component.length === 1 && !selfLoops.has(first)) continue;
		groups.push({
			edgeClass,
			members: component,
			representativePath: representativeCycle(first, new Set(component), adjacency),
		});
	}
	return groups;
}
