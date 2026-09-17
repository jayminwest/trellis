/**
 * The shared syntax and function inventory for one audit (SPEC §4 `syntax/`).
 *
 * {@link buildSyntaxInventory} consumes a discovery `SourceInventory`
 * (trellis-6003), reads and parses every classified TS/TSX file **once**, and
 * bundles the parses, function inventories, line counts, and located parse
 * diagnostics into one immutable-by-convention {@link SyntaxInventory}. Every
 * metric analyzer in the audit consumes this object — no analyzer re-reads
 * or re-parses a file, which is what makes parsing "reused across metrics
 * within one audit" (SPEC §13).
 *
 * Failure handling (SPEC §3.3): a file that fails to read or parses with
 * diagnostics still contributes a {@link FileSyntax} (read failures parse as
 * empty text); the problem is surfaced as a located {@link ParseDiagnostic}
 * and the inventory's `completeness` rolls up to `"incomplete"`. The parse
 * layer never throws on source content.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import type { Range } from "../contract/index.ts";
import type { ClassifiedFile, SourceInventory } from "../discovery/index.ts";
import { collectFunctions } from "./functions.ts";
import { parseSource } from "./parse.ts";
import { countLines } from "./sloc.ts";
import type { FileSyntax, ParseDiagnostic, SyntaxInventory } from "./types.ts";

/** A point range at line 1, column 1 — the location for file-wide problems (read failures). */
const FILE_START_RANGE: Range = {
	start: { line: 1, column: 1 },
	end: { line: 1, column: 1 },
};

/** Parse one classified file into a {@link FileSyntax}; read failures become `read-error` diagnostics. */
async function parseClassifiedFile(root: string, file: ClassifiedFile): Promise<FileSyntax> {
	const text = await readFile(join(root, file.path), "utf8").catch(() => null);
	const parsed = parseSource(file.path, text ?? "");
	const { functions, signatureCount } = collectFunctions(parsed.sourceFile);
	const diagnostics: ParseDiagnostic[] = [...parsed.diagnostics];
	if (text === null) {
		diagnostics.unshift({
			path: file.path,
			range: FILE_START_RANGE,
			code: "read-error",
			message: `could not read ${file.path}; analyzed as empty`,
		});
	}
	return {
		path: file.path,
		packagePath: file.packagePath,
		sourceSet: file.sourceSet,
		scriptKind: parsed.scriptKind,
		sourceFile: parsed.sourceFile,
		functions,
		lines: countLines(parsed.sourceFile),
		signatureCount,
		diagnostics,
	};
}

/** Order diagnostics by path, then start line, then start column. */
function byLocation(a: ParseDiagnostic, b: ParseDiagnostic): number {
	if (a.path !== b.path) return a.path < b.path ? -1 : 1;
	if (a.range.start.line !== b.range.start.line) return a.range.start.line - b.range.start.line;
	return (a.range.start.column ?? 1) - (b.range.start.column ?? 1);
}

/**
 * Build the shared syntax inventory for one audit. File order follows the
 * discovery inventory (already sorted), so the result is stable across
 * filesystem enumeration order; per-file parsing is concurrent but the
 * output positions are fixed by index, never by completion order.
 */
export async function buildSyntaxInventory(source: SourceInventory): Promise<SyntaxInventory> {
	const files = await Promise.all(
		source.files.map((file) => parseClassifiedFile(source.root, file)),
	);
	const diagnostics = files.flatMap((file) => file.diagnostics).sort(byLocation);
	return {
		root: source.root,
		compilerVersion: ts.version,
		files,
		functionCount: files.reduce((sum, file) => sum + file.functions.length, 0),
		diagnostics,
		completeness: diagnostics.length === 0 ? "complete" : "incomplete",
	};
}
