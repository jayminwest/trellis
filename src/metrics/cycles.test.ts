import { describe, expect, test } from "bun:test";
import {
	buildAdjacency,
	detectClassGroups,
	representativeCycle,
	stronglyConnectedComponents,
} from "./cycles.ts";
import type { DependencyGraph, GraphEdge } from "./graph-types.ts";

/** One directed edge pair for {@link buildAdjacency}. */
function edge(from: string, to: string): { from: string; to: string } {
	return { from, to };
}

/** Fisher–Yates shuffle with a fixed seed walk (deterministic permutation). */
function shuffled<T>(items: readonly T[], seed: number): T[] {
	const copy = [...items];
	let state = seed;
	for (let i = copy.length - 1; i > 0; i -= 1) {
		state = (state * 1103515245 + 12345) % 2147483648;
		const j = state % (i + 1);
		const a = copy[i] as T;
		copy[i] = copy[j] as T;
		copy[j] = a;
	}
	return copy;
}

describe("stronglyConnectedComponents", () => {
	test("returns only singletons for an acyclic graph", () => {
		const nodes = ["a", "b", "c"];
		const adjacency = buildAdjacency(nodes, [edge("a", "b"), edge("b", "c")]);
		expect(stronglyConnectedComponents(nodes, adjacency)).toEqual([["a"], ["b"], ["c"]]);
	});

	test("keeps disjoint cycles as separate components", () => {
		const nodes = ["a", "b", "c", "d", "e"];
		const adjacency = buildAdjacency(nodes, [
			edge("a", "b"),
			edge("b", "a"),
			edge("d", "e"),
			edge("e", "d"),
			edge("b", "c"),
		]);
		expect(stronglyConnectedComponents(nodes, adjacency)).toEqual([["a", "b"], ["c"], ["d", "e"]]);
	});

	test("merges overlapping cycles into one complete component", () => {
		const nodes = ["a", "b", "c"];
		const adjacency = buildAdjacency(nodes, [
			edge("a", "b"),
			edge("b", "a"),
			edge("b", "c"),
			edge("c", "b"),
		]);
		expect(stronglyConnectedComponents(nodes, adjacency)).toEqual([["a", "b", "c"]]);
	});

	test("is stable across node and edge enumeration order", () => {
		const nodes = ["a", "b", "c", "d", "e", "f"];
		const edges = [
			edge("a", "b"),
			edge("b", "c"),
			edge("c", "a"),
			edge("d", "e"),
			edge("e", "d"),
			edge("c", "f"),
		];
		const expected = stronglyConnectedComponents(nodes, buildAdjacency(nodes, edges));
		for (const seed of [1, 42, 1337]) {
			const permutedNodes = shuffled(nodes, seed);
			const permutedEdges = shuffled(edges, seed * 7);
			expect(
				stronglyConnectedComponents(permutedNodes, buildAdjacency(permutedNodes, permutedEdges)),
			).toEqual(expected);
		}
	});
});

describe("representativeCycle", () => {
	test("returns [p, p] for a self-loop even when a longer cycle exists", () => {
		const adjacency = buildAdjacency(["a", "b"], [edge("a", "a"), edge("a", "b"), edge("b", "a")]);
		expect(representativeCycle("a", new Set(["a", "b"]), adjacency)).toEqual(["a", "a"]);
	});

	test("returns the shortest cycle from the smallest member", () => {
		// a → b → c → a is length 3; a → d → a is length 2 and wins.
		const adjacency = buildAdjacency(
			["a", "b", "c", "d"],
			[edge("a", "b"), edge("b", "c"), edge("c", "a"), edge("a", "d"), edge("d", "a")],
		);
		expect(representativeCycle("a", new Set(["a", "b", "c", "d"]), adjacency)).toEqual([
			"a",
			"d",
			"a",
		]);
	});

	test("breaks ties lexicographically over sorted adjacency", () => {
		const adjacency = buildAdjacency(
			["a", "b", "c"],
			[edge("a", "c"), edge("a", "b"), edge("b", "a"), edge("c", "a")],
		);
		expect(representativeCycle("a", new Set(["a", "b", "c"]), adjacency)).toEqual(["a", "b", "a"]);
	});
});

/** A minimal graph with local edges only, for {@link detectClassGroups}. */
function graphWith(
	nodes: readonly string[],
	edges: readonly { from: string; to: string; typeOnly?: boolean }[],
): DependencyGraph {
	const graphEdges: GraphEdge[] = edges.map(({ from, to, typeOnly }) => ({
		from,
		kind: "import",
		typeOnly: typeOnly ?? false,
		specifier: to,
		range: { start: { line: 1 }, end: { line: 1 } },
		resolution: { status: "local", target: to },
	}));
	return {
		policyVersion: "1.0.0",
		root: "/repo",
		nodes: nodes.map((path) => ({ path, packagePath: ".", sourceSet: "production" })),
		edges: graphEdges,
		externals: [],
		configs: [],
		completeness: "complete",
	};
}

describe("detectClassGroups", () => {
	test("detects a self-import as a size-1 cyclic group", () => {
		const graph = graphWith(
			["a", "b"],
			[
				{ from: "a", to: "a" },
				{ from: "a", to: "b" },
			],
		);
		expect(detectClassGroups(graph, "runtime")).toEqual([
			{ edgeClass: "runtime", members: ["a"], representativePath: ["a", "a"] },
		]);
	});

	test("computes runtime and type-only subgraphs separately", () => {
		// a → b runtime, b → a type-only: not a cycle in either class.
		const graph = graphWith(
			["a", "b"],
			[
				{ from: "a", to: "b" },
				{ from: "b", to: "a", typeOnly: true },
			],
		);
		expect(detectClassGroups(graph, "runtime")).toEqual([]);
		expect(detectClassGroups(graph, "type-only")).toEqual([]);
	});

	test("reports a module group cyclic in both classes once per class", () => {
		const graph = graphWith(
			["a", "b"],
			[
				{ from: "a", to: "b" },
				{ from: "b", to: "a" },
				{ from: "a", to: "b", typeOnly: true },
				{ from: "b", to: "a", typeOnly: true },
			],
		);
		expect(detectClassGroups(graph, "runtime")).toEqual([
			{ edgeClass: "runtime", members: ["a", "b"], representativePath: ["a", "b", "a"] },
		]);
		expect(detectClassGroups(graph, "type-only")).toEqual([
			{ edgeClass: "type-only", members: ["a", "b"], representativePath: ["a", "b", "a"] },
		]);
	});

	test("is stable across graph edge enumeration order", () => {
		const edges = [
			{ from: "a", to: "b" },
			{ from: "b", to: "c" },
			{ from: "c", to: "a" },
			{ from: "d", to: "e" },
			{ from: "e", to: "d" },
		];
		const nodes = ["a", "b", "c", "d", "e", "f"];
		const expected = detectClassGroups(graphWith(nodes, edges), "runtime");
		const permuted = detectClassGroups(
			graphWith(shuffled(nodes, 9), shuffled(edges, 99)),
			"runtime",
		);
		expect(permuted).toEqual(expected);
	});
});
