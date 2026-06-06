/**
 * A deterministic relative-import graph over a repo's TypeScript sources, plus
 * cycle detection (SPEC §5.9 `import_cycle_detection`).
 *
 * Cycle detection is one of the few checks we can do *exactly* without invoking a
 * tool: a cycle in the relative-import graph is unambiguous (no false positives),
 * so the TS adapter computes it directly rather than asking whether madge/knip is
 * configured. We only resolve **relative** specifiers (`./` / `../`) — package
 * imports can't form intra-repo cycles — against the source set, trying the
 * usual TS resolution suffixes (`.ts`, `.tsx`, `/index.ts`, …). Bare and
 * `node:`/package specifiers are ignored.
 */
import { dirname, join, normalize } from "node:path";
import type { DetectionContext } from "../../types.ts";
import { tsSources } from "./util.ts";

/** Match `import`/`export ... from "spec"` and bare `import "spec"` specifiers. */
const SPEC_RE = /(?:import|export)\b[^;'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/g;
/** Dynamic `import("spec")` specifiers. */
const DYNAMIC_RE = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Resolution suffixes tried, in order, when a relative specifier omits one. */
const SUFFIXES = ["", ".ts", ".tsx", ".d.ts", "/index.ts", "/index.tsx"] as const;

/** Extract every relative import specifier from one file's text. */
export function relativeSpecifiers(text: string): string[] {
	const out: string[] = [];
	for (const re of [SPEC_RE, DYNAMIC_RE]) {
		re.lastIndex = 0;
		let m: RegExpExecArray | null = re.exec(text);
		while (m !== null) {
			const spec = m[1] ?? m[2] ?? m[3];
			if (spec?.startsWith(".")) out.push(spec);
			m = re.exec(text);
		}
	}
	return out;
}

/** Resolve a relative `spec` imported from `fromFile` to a member of `fileSet`, or `null`. */
export function resolveRelative(
	fromFile: string,
	spec: string,
	fileSet: ReadonlySet<string>,
): string | null {
	const base = normalize(join(dirname(fromFile), spec)).replace(/\\/g, "/");
	const stripped = base.replace(/\.(ts|tsx)$/, "");
	for (const suffix of SUFFIXES) {
		const candidate = `${stripped}${suffix}`;
		if (fileSet.has(candidate)) return candidate;
	}
	// Also try the literal target (covers specifiers that already carry an ext).
	return fileSet.has(base) ? base : null;
}

/** A resolved adjacency map: file → the in-repo files it imports. */
export type ImportGraph = ReadonlyMap<string, readonly string[]>;

/** Build the relative-import graph over the app's TypeScript sources. */
export async function buildImportGraph(ctx: DetectionContext): Promise<ImportGraph> {
	const files = await tsSources(ctx);
	const fileSet = new Set(files);
	const graph = new Map<string, string[]>();
	for (const file of files) {
		const text = await ctx.readFile(file);
		const edges: string[] = [];
		if (text !== null) {
			for (const spec of relativeSpecifiers(text)) {
				const target = resolveRelative(file, spec, fileSet);
				if (target !== null && target !== file) edges.push(target);
			}
		}
		graph.set(file, [...new Set(edges)].sort());
	}
	return graph;
}

/** DFS coloring states. */
const WHITE = 0;
const GRAY = 1;
const BLACK = 2;

/** Slice a path at the back-edge target to produce the closed cycle (`[…, back]`). */
function closeCycle(path: string[], back: string): string[] {
	const idx = path.indexOf(back);
	return idx >= 0 ? [...path.slice(idx), back] : [...path, back];
}

/** Iterative DFS from one `start`, returning the first cycle on its path, or `null`. */
function dfsFrom(start: string, graph: ImportGraph, color: Map<string, number>): string[] | null {
	const stack: { node: string; path: string[] }[] = [{ node: start, path: [start] }];
	color.set(start, GRAY);
	while (stack.length > 0) {
		const top = stack[stack.length - 1];
		if (top === undefined) break;
		const edges = graph.get(top.node) ?? [];
		const back = edges.find((n) => color.get(n) === GRAY);
		if (back !== undefined) return closeCycle(top.path, back);
		const next = edges.find((n) => color.get(n) === WHITE);
		if (next === undefined) {
			color.set(top.node, BLACK);
			stack.pop();
			continue;
		}
		color.set(next, GRAY);
		stack.push({ node: next, path: [...top.path, next] });
	}
	return null;
}

/**
 * The first import cycle found via iterative DFS (path-stack), or `null` if the
 * graph is acyclic. Deterministic: nodes and edges are visited in sorted order.
 */
export function findCycle(graph: ImportGraph): string[] | null {
	const color = new Map<string, number>();
	const nodes = [...graph.keys()].sort();
	for (const node of nodes) color.set(node, WHITE);
	for (const start of nodes) {
		if (color.get(start) !== WHITE) continue;
		const cycle = dfsFrom(start, graph, color);
		if (cycle !== null) return cycle;
	}
	return null;
}
