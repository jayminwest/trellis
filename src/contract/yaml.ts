/**
 * The one YAML entry point for trellis's declarative inputs (trellis.yaml,
 * targets.yaml, workflows, pnpm-workspace.yaml, the standards manifest) —
 * js-yaml 5 behind the semantics every caller was written against
 * (trellis-06cd):
 *
 * - an empty or comment-only document parses to `undefined` (js-yaml 5's
 *   `load` throws "expected a document" instead);
 * - `<<` merge keys resolve, as under js-yaml 4's default schema (js-yaml 5's
 *   core schema drops the merge tag);
 * - a multi-document stream is an error, never silently truncated.
 *
 * Callers still treat every parse failure as untrusted-input failure and
 * validate the result with zod at the boundary.
 */
import { CORE_SCHEMA, loadAll, mergeTag } from "js-yaml";

const SCHEMA = CORE_SCHEMA.withTags(mergeTag);

/** Parse one YAML document; `undefined` when the source holds no document. */
export function parseYaml(text: string): unknown {
	const documents = loadAll(text, { schema: SCHEMA });
	if (documents.length > 1) {
		throw new Error(`expected a single YAML document, found ${documents.length}`);
	}
	return documents[0];
}
