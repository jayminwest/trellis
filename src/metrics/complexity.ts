/**
 * Per-function cyclomatic complexity and maximum nesting depth (SPEC §5.1).
 *
 * **Cyclomatic complexity (CC)** — `CC = 1 + decisions`, where `decisions`
 * counts exactly these AST nodes in the function's **own** subtree:
 *
 * | Decision                                   | Counts |
 * | ------------------------------------------ | ------ |
 * | `if` / `else if` (each `IfStatement`)      | +1     |
 * | `for`, `for-in`, `for-of`, `while`, `do`   | +1     |
 * | each `case` clause (`CaseClause`)          | +1     |
 * | `catch` clause                             | +1     |
 * | conditional expression (`?:`)              | +1     |
 * | binary `&&`, `\|\|`, `??`                  | +1 per operator |
 * | logical assignment `&&=`, `\|\|=`, `??=`   | +1 per operator |
 * | each optional-chaining `?.` token          | +1     |
 *
 * Explicitly **not** counted: a plain `else`, a `default:` clause (it is
 * the switch's fall-through, not a branch), the non-null assertion `!`,
 * optional *type* markers (`foo?: string` — a `QuestionToken`, never a
 * `QuestionDotToken`), `break`/`continue`, and `throw`. An `else if` chain
 * is a sequence of `IfStatement`s, so each link counts once; `a && b && c`
 * is two binary expressions and counts twice; `a?.b?.c` has two `?.` tokens
 * and counts twice.
 *
 * **Attribution** (SPEC §5.1): nested functions are walked as opaque leaves
 * (`walkOwnNodes`), so a nested function's decisions are attributed to the
 * nested function alone and never fold into the parent's CC. Overload
 * signatures have no body and are not inventory entries at all (syntax
 * layer), so they contribute nothing.
 *
 * **Maximum nesting depth** — the deepest control-structure nesting inside
 * the function's own subtree, where descending into an `if`, any loop,
 * a `switch`, or a `try` adds one level. `case`/`default` clauses, `catch`/
 * `finally` clauses, and blocks add **no** level of their own (a `catch`
 * body sits at the `try`'s level). An `else if` chain nests: the inner
 * `if` is inside the outer `if`, so each link adds one level. Nested
 * functions are opaque; a nested function's own depth starts at 0.
 */
import ts from "typescript";
import { type FunctionFacts, walkOwnNodes } from "../syntax/index.ts";

/** Node kinds that each contribute one CC decision (see the module table). */
const BRANCH_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
	ts.SyntaxKind.IfStatement,
	ts.SyntaxKind.ForStatement,
	ts.SyntaxKind.ForInStatement,
	ts.SyntaxKind.ForOfStatement,
	ts.SyntaxKind.WhileStatement,
	ts.SyntaxKind.DoStatement,
	ts.SyntaxKind.CaseClause,
	ts.SyntaxKind.CatchClause,
	ts.SyntaxKind.ConditionalExpression,
]);

/** Binary operator tokens that short-circuit and therefore each add one CC decision. */
const LOGICAL_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
	ts.SyntaxKind.AmpersandAmpersandToken,
	ts.SyntaxKind.BarBarToken,
	ts.SyntaxKind.QuestionQuestionToken,
	ts.SyntaxKind.AmpersandAmpersandEqualsToken,
	ts.SyntaxKind.BarBarEqualsToken,
	ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

/** Node kinds whose interior adds one nesting level (see the module docblock). */
const NESTING_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
	ts.SyntaxKind.IfStatement,
	ts.SyntaxKind.ForStatement,
	ts.SyntaxKind.ForInStatement,
	ts.SyntaxKind.ForOfStatement,
	ts.SyntaxKind.WhileStatement,
	ts.SyntaxKind.DoStatement,
	ts.SyntaxKind.SwitchStatement,
	ts.SyntaxKind.TryStatement,
]);

/** CC decisions contributed by one node (0 for non-decisions). */
function decisionsOf(node: ts.Node): number {
	if (BRANCH_KINDS.has(node.kind)) return 1;
	if (ts.isBinaryExpression(node) && LOGICAL_OPERATORS.has(node.operatorToken.kind)) return 1;
	if (
		(ts.isPropertyAccessExpression(node) ||
			ts.isCallExpression(node) ||
			ts.isElementAccessExpression(node)) &&
		node.questionDotToken !== undefined
	) {
		return 1;
	}
	return 0;
}

/**
 * Nesting level of `node`: the count of {@link NESTING_KINDS} ancestors
 * strictly between `node` and the owning function `stop` (exclusive).
 */
function nestingOf(node: ts.Node, stop: ts.Node): number {
	let depth = 0;
	let current = node.parent;
	while (current !== undefined && current !== stop) {
		if (NESTING_KINDS.has(current.kind)) depth += 1;
		current = current.parent;
	}
	return depth;
}

/** The per-function complexity measurement. */
export interface FunctionComplexity {
	/** Cyclomatic complexity: 1 + decisions (minimum 1, even for an empty body). */
	cc: number;
	/** Deepest control-structure nesting; 0 for a body with no control structures. */
	maxNesting: number;
}

/**
 * Measure one inventoried function over the shared parse (see the module
 * docblock for the exact decision table and nesting rule). Pure: same tree,
 * same numbers.
 */
export function measureFunctionComplexity(fn: FunctionFacts): FunctionComplexity {
	let decisions = 0;
	let maxNesting = 0;
	walkOwnNodes(fn, (node) => {
		decisions += decisionsOf(node);
		const depth = nestingOf(node, fn.node);
		if (depth > maxNesting) maxNesting = depth;
	});
	return { cc: 1 + decisions, maxNesting };
}
