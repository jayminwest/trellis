/** Experimental protocol v1; not Sonar Cognitive Complexity or a quality score. */
import ts from "typescript";
import { measureFunctionComplexity } from "../metrics/complexity.ts";
import { type FunctionFacts, walkOwnNodes } from "../syntax/index.ts";

const STRUCTURES = new Set([
	ts.SyntaxKind.IfStatement,
	ts.SyntaxKind.ForStatement,
	ts.SyntaxKind.ForInStatement,
	ts.SyntaxKind.ForOfStatement,
	ts.SyntaxKind.WhileStatement,
	ts.SyntaxKind.DoStatement,
	ts.SyntaxKind.SwitchStatement,
	ts.SyntaxKind.CatchClause,
	ts.SyntaxKind.ConditionalExpression,
]);
const BOOLEAN_OPERATORS = new Set([
	ts.SyntaxKind.AmpersandAmpersandToken,
	ts.SyntaxKind.BarBarToken,
]);

function isElseIf(node: ts.Node): boolean {
	return (
		ts.isIfStatement(node) && ts.isIfStatement(node.parent) && node.parent.elseStatement === node
	);
}

function structuralDepth(node: ts.Node, stop: ts.Node): number {
	let depth = 0;
	let parent = node.parent;
	while (parent && parent !== stop) {
		if (STRUCTURES.has(parent.kind) && !isElseIf(parent)) depth += 1;
		parent = parent.parent;
	}
	return depth - Number(isElseIf(node));
}

/** Sum 1 + enclosing structural depth; else-if links share their chain's depth. */
export function measureFlow(fn: FunctionFacts) {
	let structural = 0;
	let nesting = 0;
	let booleanOperators = 0;
	let calls = 0;
	walkOwnNodes(fn, (node) => {
		if (ts.isCallExpression(node)) calls += 1;
		if (ts.isBinaryExpression(node) && BOOLEAN_OPERATORS.has(node.operatorToken.kind))
			booleanOperators += 1;
		if (!STRUCTURES.has(node.kind)) return;
		structural += 1;
		nesting += structuralDepth(node, fn.node);
	});
	return {
		...measureFunctionComplexity(fn),
		flow: structural + nesting + booleanOperators,
		structural,
		nesting,
		booleanOperators,
		calls,
	};
}
