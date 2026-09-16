/**
 * Duplication detection (SPEC §5.3, trellis-6e4c) — trellis's own
 * normalized-token clone detector over the shared syntax inventory. No
 * runtime dependency: the pinned compiler's AST walk yields the token
 * stream, and detection is hashing plus arithmetic over it.
 *
 * This module holds the detection **contract** (types, budgets, minimums)
 * and the token-stream collector; the matching engine lives in
 * `duplication-detect.ts` and group finalization in `duplication-groups.ts`.
 *
 * Documented semantics (fixed by the trellis-5a91 decision, SPEC §5.3):
 *
 * - **Token stream**: the leaf tokens of the shared `ts.SourceFile` in
 *   document order (comments and trivia never appear; the end-of-file
 *   token is dropped). A raw scanner loop is deliberately not used — it
 *   mis-tokenizes template literals without manual re-scan state.
 * - **Normalization**: every identifier maps to one placeholder, every
 *   literal (string, numeric, bigint, regex, template part) maps to one
 *   placeholder; all other tokens keep their `SyntaxKind`. This detects
 *   exact (type-1) and identifier/literal-renamed (type-2) clones. Near
 *   clones (type-3) are out of scope: a divergence splits a match into
 *   maximal exact-normalized runs, each reported independently.
 * - **Minimum clone size** (provisional; trellis-e924 calibrates):
 *   {@link DUPLICATION_MIN_TOKENS} normalized tokens **and**
 *   {@link DUPLICATION_MIN_LINES} lines, both required, per member.
 * - **Grouping**: a clone group is the set of ranges sharing one identical
 *   normalized token sequence (content identity), with at least two
 *   members after dropping same-file token-contained members; there is no
 *   transitive pairwise merging. A group whose every member is
 *   token-contained in members of other groups is subsumed and dropped
 *   (the shared region of two overlapping clones is not a third clone).
 *   Within-file repeats count as clones.
 * - **Ranges** are token-exact maximal runs; a reported line range may
 *   overhang a partial boundary line (accepted semantics, matching both
 *   jscpd engines).
 * - **Bounded feasibility**: {@link DuplicationBudget} declares a token
 *   count and a match-work budget; exhaustion trips `incomplete` with the
 *   reason — never a silent clean result.
 *
 * Detection runs **per source set** (the caller passes one set's streams);
 * token streams are never matched across sets. Ordering is deterministic:
 * groups and members are sorted by location, never by filesystem
 * enumeration or hash-map order.
 */
import ts from "typescript";
import type { Range, SourceSet } from "../contract/index.ts";
import { type FileSyntax, positionAt } from "../syntax/index.ts";

/** Minimum normalized-token run for a clone member (provisional, SPEC §5.3). */
export const DUPLICATION_MIN_TOKENS = 50;
/** Minimum line span for a clone member (provisional, SPEC §5.3). */
export const DUPLICATION_MIN_LINES = 3;

/** Declared resource budgets for one source set's detection run (SPEC §5.3). */
export interface DuplicationBudget {
	/** Maximum normalized tokens tokenized in one source set. */
	maxTokens: number;
	/** Maximum token comparisons during window verification, extension, and group merging. */
	maxMatchWork: number;
}

/**
 * Default budgets (land with trellis-6e4c; the corpus stage trellis-e924
 * tunes them). The token budget covers the largest observed corpus by an
 * order of magnitude; the work budget bounds the quadratic pair-extension
 * worst case of pathological high-multiplicity clone classes.
 */
export const DEFAULT_DUPLICATION_BUDGET: DuplicationBudget = {
	maxTokens: 2_000_000,
	maxMatchWork: 100_000_000,
};

/** Which budget tripped, and at what limit (SPEC §3.3 `incomplete` reason). */
export interface BudgetExhaustion {
	kind: "token-count" | "match-work";
	limit: number;
}

/** The normalized token stream of one parsed file (see the module docblock). */
export interface TokenStream {
	/** Repo-relative POSIX path. */
	path: string;
	/** Owning package root from discovery. */
	packagePath: string;
	sourceSet: SourceSet;
	/** Normalized token kinds in document order. */
	kinds: ts.SyntaxKind[];
	/** 1-based line of each token's start. */
	startLines: number[];
	/** 1-based line of each token's end. */
	endLines: number[];
}

/** One member of a clone group: a token-exact maximal run, located by line range. */
export interface CloneMember {
	/** Repo-relative POSIX path. */
	path: string;
	/** 1-based line range (may overhang a partial boundary line — accepted semantics). */
	range: Range;
	/** Normalized tokens in the member run (equal across a group's members). */
	tokenCount: number;
	/** Line span of the range (`end - start + 1`). */
	lineCount: number;
}

/** A stable clone group: one identical normalized token sequence, ≥2 members. */
export interface CloneGroup {
	/** Stable identifier assigned after deterministic sorting (`clone-group-1`, …). */
	id: string;
	/** Normalized tokens per member run. */
	tokenCount: number;
	/** Members sorted by path, then start line, then end line. */
	members: CloneMember[];
}

/** The detection outcome for one source set. */
export interface CloneDetection {
	/** Surviving groups, sorted deterministically (see the module docblock). */
	groups: CloneGroup[];
	/** Normalized tokens tokenized in the set. */
	tokenCount: number;
	/** The budget that tripped, or `null` when detection ran to completion. */
	exhaustion: BudgetExhaustion | null;
}

/** Literal-like kinds that all normalize to one placeholder (SPEC §5.3). */
const LITERAL_KINDS = new Set<ts.SyntaxKind>([
	ts.SyntaxKind.StringLiteral,
	ts.SyntaxKind.NumericLiteral,
	ts.SyntaxKind.BigIntLiteral,
	ts.SyntaxKind.RegularExpressionLiteral,
	ts.SyntaxKind.NoSubstitutionTemplateLiteral,
	ts.SyntaxKind.TemplateHead,
	ts.SyntaxKind.TemplateMiddle,
	ts.SyntaxKind.TemplateTail,
]);

/** The one literal placeholder: every literal normalizes to `StringLiteral`. */
const LITERAL_PLACEHOLDER = ts.SyntaxKind.StringLiteral;

/** Normalize one token kind per the documented rules (module docblock). */
function normalizeKind(kind: ts.SyntaxKind): ts.SyntaxKind {
	if (LITERAL_KINDS.has(kind)) return LITERAL_PLACEHOLDER;
	return kind;
}

/**
 * Collect the normalized token stream of one parsed file. Iterative (an
 * explicit stack, so pathologically deep ASTs cannot overflow the call
 * stack); leaf tokens are visited in document order. The end-of-file token
 * is dropped so file-final clones are not artificially extended.
 */
export function collectTokenStream(file: FileSyntax): TokenStream {
	const sourceFile = file.sourceFile;
	const kinds: ts.SyntaxKind[] = [];
	const startLines: number[] = [];
	const endLines: number[] = [];
	const stack: ts.Node[] = [sourceFile];
	while (stack.length > 0) {
		const node = stack.pop();
		if (node === undefined) continue;
		const children = node.getChildren(sourceFile);
		if (children.length === 0) {
			if (node.kind === ts.SyntaxKind.EndOfFileToken) continue;
			kinds.push(normalizeKind(node.kind));
			startLines.push(positionAt(sourceFile, node.getStart(sourceFile)).line);
			endLines.push(positionAt(sourceFile, node.getEnd()).line);
			continue;
		}
		for (let index = children.length - 1; index >= 0; index -= 1) {
			const child = children[index];
			if (child !== undefined) stack.push(child);
		}
	}
	return {
		path: file.path,
		packagePath: file.packagePath,
		sourceSet: file.sourceSet,
		kinds,
		startLines,
		endLines,
	};
}
