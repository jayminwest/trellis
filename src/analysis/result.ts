/**
 * Internal analysis interfaces (SPEC §16, trellis-90d6, AC4).
 *
 * The **minimum result interface** is the versioned contract
 * (`analysisResultSchema`): native analyzers and external providers are
 * represented through the same validated shape. This module layers the
 * typed **internal products** on top: a producer may hand downstream native
 * analyzers its graph and clone products (the shared dependency graph, the
 * native clone groups) in-process, beyond what the serialized minimum
 * carries. Internal products are never serialized into the report — use
 * {@link toContractResult} to obtain the contract view.
 */
import type { z } from "zod";
import type { analysisResultSchema } from "../contract/analysis-result.ts";
import type { CloneGroup } from "../metrics/duplication.ts";
import type { GraphEdge, GraphNode } from "../metrics/graph-types.ts";

/** The minimum analysis result interface shared by native and external producers (§16.2, AC4). */
export type AnalysisResult = z.infer<typeof analysisResultSchema>;

/** Typed internal dependency-graph product for downstream analyzers (native graph, SPEC §5.4). */
export interface GraphAnalysisProduct {
	nodes: readonly GraphNode[];
	edges: readonly GraphEdge[];
}

/** Typed internal clone product for downstream analyzers (native clone groups, SPEC §5.3). */
export interface CloneAnalysisProduct {
	groups: readonly CloneGroup[];
}

/** Internal products a producer may attach beyond the serialized minimum. */
export interface AnalysisProducts {
	graph?: GraphAnalysisProduct;
	clones?: CloneAnalysisProduct;
}

/** An in-process result carrying internal products for downstream analyzers. */
export interface InternalAnalysisResult extends AnalysisResult {
	products?: AnalysisProducts;
}

/**
 * The contract view of an internal result: internal products are stripped so
 * the result validates against the strict minimum schema (which rejects
 * unknown keys). Products are additive in-process, never in the report.
 */
export function toContractResult(result: InternalAnalysisResult): AnalysisResult {
	const { products: _products, ...contract } = result;
	return contract;
}
