/**
 * Shared syntax-layer contract (SPEC §4 `syntax/`, §13 "one shared parse layer").
 *
 * The syntax layer parses every classified TS/TSX file **once per audit** and
 * exposes the resulting facts — the parsed `ts.SourceFile`, the function
 * inventory, source-line counts, and located parse diagnostics — to every
 * metric analyzer (complexity trellis-fbc5, duplication trellis-5a91, import
 * cycles trellis-d214). It embeds **no scoring**: everything here is a raw,
 * reproducible fact about the source text.
 *
 * Documented rules (binding on all consumers):
 *
 * - **Positions** are 1-based `{ line, column }` pairs from the pinned
 *   compiler's own line map, so a {@link FunctionFacts.range} is directly
 *   usable as a contract `Finding.range` (§6.2).
 * - **Ownership**: every {@link FileSyntax} carries the discovery layer's
 *   `packagePath` and `sourceSet`; every {@link FunctionFacts} carries the
 *   `parentIndex` of its directly enclosing function. A nested function body
 *   belongs to the nested function alone — analyzers measuring a parent walk
 *   it with `walkOwnNodes` (see `functions.ts`), which treats nested
 *   functions as opaque leaves, so nested branches can never leak into parent
 *   totals (SPEC §5.1).
 * - **Overloads / signatures**: a function-like node without a body (overload
 *   signatures, `declare function`, abstract methods) is **not** an inventory
 *   entry. It is counted once in {@link FileSyntax.signatureCount}, and the
 *   implementation it belongs to records the count in
 *   {@link FunctionFacts.overloadSignatures}.
 */
import type ts from "typescript";
import type { Completeness, Range, SourceSet } from "../contract/index.ts";
import type { FunctionIdentity } from "./identity.ts";

/** The function-like node kinds the inventory recognizes (SPEC §5.1). */
export const FUNCTION_KINDS = [
	"function-declaration",
	"function-expression",
	"arrow-function",
	"method",
	"constructor",
	"get-accessor",
	"set-accessor",
] as const;

export type FunctionKind = (typeof FUNCTION_KINDS)[number];

/** Script variant chosen from the file extension: `.tsx` → TSX, everything else → TS. */
export type ScriptVariant = "ts" | "tsx";

/**
 * One located parse problem (SPEC §3.3 `incomplete`). `code` is `"TS<n>"` for
 * a compiler parse diagnostic and `"read-error"` when the file could not be
 * read at all. Positions are 1-based; a diagnostic without a span points at
 * line 1, column 1.
 */
export interface ParseDiagnostic {
	/** Repo-relative POSIX path of the file. */
	path: string;
	range: Range;
	code: string;
	message: string;
}

/**
 * Source-line counts for one file (SPEC §5.1 "source size").
 *
 * Documented rules:
 * - `total` is the number of line starts in the text; a file ending in a
 *   newline therefore has a final **blank** line, and
 *   `code + commentOnly + blank === total` always holds.
 * - A line is `code` when at least one non-trivia token covers it. Lines
 *   spanned by a multiline literal (template string, multiline string
 *   content) are `code` on every line they occupy — the literal is
 *   executable content, not commentary.
 * - A line with no token but at least one comment (`//` or block comment,
 *   including the interior lines of a multiline block comment) is
 *   `commentOnly`.
 * - Everything else (whitespace-only lines) is `blank`.
 */
export interface LineCounts {
	total: number;
	code: number;
	commentOnly: number;
	blank: number;
}

/**
 * One function-like node **with a body** in the inventory. Bodiless nodes
 * (overload signatures, declarations) never appear here — see the module
 * docblock. `node` is the live AST node in the file's shared
 * `ts.SourceFile`, so analyzers walk the same parse instead of re-parsing;
 * `node.getSourceFile()` is always the owning {@link FileSyntax.sourceFile}.
 */
export interface FunctionFacts {
	/** Scoped identity, derived from this file's shared AST after sibling registration. */
	identity: FunctionIdentity;
	kind: FunctionKind;
	/**
	 * Display name per the documented naming rule: the declared name for
	 * declarations/methods/accessors (`"constructor"` for constructors); for
	 * expressions and arrows the contextual name (variable declarator or
	 * property-assignment name); otherwise `"(anonymous)"`.
	 */
	name: string;
	/** Where {@link name} came from (traceability). */
	nameOrigin: "declared" | "contextual" | "anonymous";
	/** The function-like AST node inside the shared parse. */
	node: ts.Node;
	/** Whole-node range (signature through closing brace), 1-based. */
	range: Range;
	/** Body-only range; for an expression-bodied arrow, the expression. */
	bodyRange: Range;
	/** Number of enclosing functions; `0` for top-level functions. */
	depth: number;
	/** Index into the owning file's `functions` array of the directly enclosing function, else `null`. */
	parentIndex: number | null;
	/** Bodiless overload signatures attached to this implementation (0 for kinds that cannot overload). */
	overloadSignatures: number;
}

/** One parsed file: the shared parse plus every derived fact. */
export interface FileSyntax {
	/** Repo-relative POSIX path. */
	path: string;
	/** Owning package root from discovery (`.` for the repo root). */
	packagePath: string;
	sourceSet: SourceSet;
	scriptKind: ScriptVariant;
	/** The one shared parse of this file — reused by every analyzer. */
	sourceFile: ts.SourceFile;
	/** Inventoried functions in source order (pre-order: parents precede nested children). */
	functions: FunctionFacts[];
	lines: LineCounts;
	/** Bodiless function-like signatures seen (overload/`declare`/abstract); never inventoried. */
	signatureCount: number;
	/** Located parse problems; empty when the parse was clean. */
	diagnostics: ParseDiagnostic[];
}

/**
 * The shared syntax and function inventory for one audit (SPEC §4). Built
 * once from a discovery `SourceInventory`, then reused by every metric —
 * building it is the only parsing an audit performs.
 */
export interface SyntaxInventory {
	/** Absolute audited root. */
	root: string;
	/** Pinned compiler identity (`ts.version`) that produced these facts (traceability). */
	compilerVersion: string;
	/** Parsed files in the discovery inventory's (sorted) order. */
	files: FileSyntax[];
	/** Total inventoried functions across all files. */
	functionCount: number;
	/** Every parse diagnostic, sorted by path then line then column. */
	diagnostics: ParseDiagnostic[];
	/** `"incomplete"` when any file produced diagnostics (SPEC §3.3). */
	completeness: Completeness;
}
