/**
 * Shared TypeScript syntax and function inventory (SPEC §4 `syntax/`).
 *
 * One parse layer — pinned TypeScript compiler API — reused by every metric
 * within an audit: {@link buildSyntaxInventory} turns a discovery
 * `SourceInventory` into a {@link SyntaxInventory} carrying parsed
 * `ts.SourceFile`s, the function inventory ({@link FunctionFacts}), line
 * counts ({@link LineCounts}), and located {@link ParseDiagnostic}s. Facts
 * only — scoring lives downstream (trellis-00d5).
 *
 * The binding rules (positions, ownership/nesting attribution, overload and
 * line-count handling) are documented in `types.ts`, `functions.ts`, and
 * `sloc.ts`.
 */
export { collectFunctions, type FileFunctions, walkOwnNodes } from "./functions.ts";
export { buildSyntaxInventory } from "./inventory.ts";
export {
	type ParsedSource,
	parseSource,
	positionAt,
	rangeAt,
	scriptVariantForPath,
} from "./parse.ts";
export { classifyLines, countLines, type LineKind } from "./sloc.ts";
export {
	type FileSyntax,
	FUNCTION_KINDS,
	type FunctionFacts,
	type FunctionKind,
	type LineCounts,
	type ParseDiagnostic,
	type ScriptVariant,
	type SyntaxInventory,
} from "./types.ts";
