/**
 * Source-line classification (SPEC §5.1 "source size") — the documented
 * handling of multiline literals and comment-only lines.
 *
 * Classification is driven by the pinned compiler's **scanner**, not by
 * regexes: a line is `code` when a real token covers it, `commentOnly` when
 * only comment trivia covers it, and `blank` otherwise. Because tokens and
 * comments are located by the scanner:
 *
 * - every line spanned by a multiline literal (a template string's raw text,
 *   a multiline string) is `code` — the literal is executable content;
 * - every interior line of a multiline block comment is `commentOnly`;
 * - a line holding both code and a trailing comment is `code`;
 * - comment-like text *inside* a string literal never makes a line a
 *   comment, and code-like text inside a comment never makes one code.
 */
import ts from "typescript";
import type { LineCounts } from "./types.ts";

const COMMENT_TRIVIA = new Set<ts.SyntaxKind>([
	ts.SyntaxKind.SingleLineCommentTrivia,
	ts.SyntaxKind.MultiLineCommentTrivia,
]);

/** Other trivia the scanner can emit (never code, never comment). */
const PLAIN_TRIVIA = new Set<ts.SyntaxKind>([
	ts.SyntaxKind.WhitespaceTrivia,
	ts.SyntaxKind.NewLineTrivia,
	ts.SyntaxKind.ShebangTrivia,
	ts.SyntaxKind.ConflictMarkerTrivia,
]);

/** The classification of one physical line (see the module docblock). */
export type LineKind = "code" | "commentOnly" | "blank";

/** Mutable per-line flags, folded into {@link LineCounts} at the end. */
interface LineFlags {
	code: boolean;
	comment: boolean;
}

/** The line containing `pos` (index into `lineStarts`, via binary search). */
function lineOf(lineStarts: readonly number[], pos: number): number {
	let lo = 0;
	let hi = lineStarts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if ((lineStarts[mid] ?? 0) <= pos) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/** Mark every line covered by [`start`, `end`) with the given flag. */
function markLines(
	flags: LineFlags[],
	lineStarts: readonly number[],
	start: number,
	end: number,
	key: "code" | "comment",
): void {
	const first = lineOf(lineStarts, start);
	const last = lineOf(lineStarts, Math.max(start, end - 1));
	for (let line = first; line <= last; line += 1) {
		const entry = flags[line];
		if (entry !== undefined) entry[key] = true;
	}
}

/**
 * Classify every line of `sourceFile` (see the module docblock for the
 * rules). The scan reuses the shared parse's own line map and language
 * variant, so positions always agree with the parse layer's ranges. The
 * result is indexed by 0-based line number, so contract (1-based) line `n`
 * is `classifyLines(sf)[n - 1]`. Analyzers that need a line-range
 * classification (e.g. per-function SLOC, trellis-fbc5) scan once per file
 * through this function instead of re-running the scanner per range.
 */
export function classifyLines(sourceFile: ts.SourceFile): readonly LineKind[] {
	const lineStarts = sourceFile.getLineStarts();
	const flags: LineFlags[] = [...lineStarts].map(() => ({ code: false, comment: false }));
	const scanner = ts.createScanner(
		ts.ScriptTarget.ESNext,
		/* skipTrivia */ false,
		sourceFile.languageVariant,
		sourceFile.text,
	);
	let token = scanner.scan();
	while (token !== ts.SyntaxKind.EndOfFileToken) {
		if (COMMENT_TRIVIA.has(token)) {
			markLines(flags, lineStarts, scanner.getTokenStart(), scanner.getTokenEnd(), "comment");
		} else if (!PLAIN_TRIVIA.has(token)) {
			markLines(flags, lineStarts, scanner.getTokenStart(), scanner.getTokenEnd(), "code");
		}
		token = scanner.scan();
	}
	return flags.map((flag) => (flag.code ? "code" : flag.comment ? "commentOnly" : "blank"));
}

/** Fold a per-line classification into {@link LineCounts} totals. */
export function countLines(sourceFile: ts.SourceFile): LineCounts {
	const kinds = classifyLines(sourceFile);
	const counts: LineCounts = { total: kinds.length, code: 0, commentOnly: 0, blank: 0 };
	for (const kind of kinds) {
		if (kind === "code") counts.code += 1;
		else if (kind === "commentOnly") counts.commentOnly += 1;
		else counts.blank += 1;
	}
	return counts;
}
