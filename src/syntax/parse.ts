/**
 * The one shared parse of a single source file (SPEC §13 "pinned TypeScript
 * compiler API").
 *
 * Parsing is **syntax-only** (`ts.createSourceFile`): no program, no type
 * resolution, no `tsconfig`, no `node_modules` — the audit works on trees
 * with uninstalled dependencies (SPEC §1 offline invariant). The compiler
 * version is pinned in `package.json` (`dependencies.typescript`, exact) so
 * every audit parses with the same grammar.
 *
 * Parse problems never throw and never abort the file: the compiler recovers
 * and still produces a (partial) tree, and every problem is surfaced as a
 * located {@link ParseDiagnostic} so the audit reports `incomplete` with the
 * exact where (SPEC §3.3).
 */
import ts from "typescript";
import type { Range } from "../contract/index.ts";
import type { ParseDiagnostic, ScriptVariant } from "./types.ts";

/** Script variant from the repo-relative path: `.tsx` parses as TSX, `.ts`/`.mts`/`.cts` as TS. */
export function scriptVariantForPath(path: string): ScriptVariant {
	return path.endsWith(".tsx") ? "tsx" : "ts";
}

/** 1-based `{ line, column }` position of `pos` in `sourceFile`. */
export function positionAt(
	sourceFile: ts.SourceFile,
	pos: number,
): { line: number; column: number } {
	const { line, character } = ts.getLineAndCharacterOfPosition(sourceFile, pos);
	return { line: line + 1, column: character + 1 };
}

/** 1-based contract `Range` covering [`startPos`, `endPos`) in `sourceFile`. */
export function rangeAt(sourceFile: ts.SourceFile, startPos: number, endPos: number): Range {
	return { start: positionAt(sourceFile, startPos), end: positionAt(sourceFile, endPos) };
}

/** Convert one compiler diagnostic to a located {@link ParseDiagnostic}. */
function toDiagnostic(
	sourceFile: ts.SourceFile,
	path: string,
	diagnostic: ts.DiagnosticWithLocation,
): ParseDiagnostic {
	const start = diagnostic.start;
	const length = diagnostic.length ?? 0;
	return {
		path,
		range: rangeAt(sourceFile, start, start + length),
		code: `TS${diagnostic.code}`,
		message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
	};
}

/** The result of parsing one file: the shared tree plus located diagnostics. */
export interface ParsedSource {
	sourceFile: ts.SourceFile;
	scriptKind: ScriptVariant;
	diagnostics: ParseDiagnostic[];
}

/**
 * The pinned 6.0 compiler still records parse diagnostics on the
 * `SourceFile` at runtime, but its public typings no longer declare the
 * field. Access goes through this narrow structural type — never `any` —
 * and `parse.test.ts` asserts against the pinned version that real syntax
 * errors surface here, so a compiler bump that drops the field fails tests
 * instead of silently reporting broken files as clean.
 */
interface ParseDiagnosticsCarrier {
	parseDiagnostics?: readonly ts.DiagnosticWithLocation[];
}

/** The parser-recorded diagnostics of `sourceFile` (see {@link ParseDiagnosticsCarrier}). */
function parseDiagnosticsOf(sourceFile: ts.SourceFile): readonly ts.DiagnosticWithLocation[] {
	return (sourceFile as ParseDiagnosticsCarrier).parseDiagnostics ?? [];
}

/**
 * Parse `text` as the file at repo-relative `path`. `parseDiagnostics` is
 * populated because the tree is created with parent pointers — the same
 * setting analyzers need to walk upward, so the shared parse serves both.
 */
export function parseSource(path: string, text: string): ParsedSource {
	const scriptKind = scriptVariantForPath(path);
	const sourceFile = ts.createSourceFile(
		path,
		text,
		ts.ScriptTarget.ESNext,
		/* setParentNodes */ true,
		scriptKind === "tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	return {
		sourceFile,
		scriptKind,
		diagnostics: parseDiagnosticsOf(sourceFile).map((diagnostic) =>
			toDiagnostic(sourceFile, path, diagnostic),
		),
	};
}
