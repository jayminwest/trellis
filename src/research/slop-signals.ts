/** Experimental evidence only (trellis-2d45); deliberately outside audit/scoring. */
import ts from "typescript";
import type { Range } from "../contract/index.ts";
import { type FileSyntax, type FunctionFacts, rangeAt } from "../syntax/index.ts";

export interface Site {
	path: string;
	range: Range;
}

export interface Forwarder extends Site {
	name: string;
	target: string;
	parameters: number;
	isAsync: boolean;
}

export interface Dispatch extends Site {
	expression: string;
	cases: string[];
	hasDefault: boolean;
}

function unwrap(node: ts.Expression): ts.Expression {
	return ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
}

function returnedCall(body: ts.ConciseBody): ts.CallExpression | undefined {
	let expression: ts.Expression | undefined;
	if (ts.isBlock(body)) {
		const statement = body.statements[0];
		if (body.statements.length !== 1 || !statement || !ts.isReturnStatement(statement))
			return undefined;
		expression = statement.expression;
	} else expression = body;
	if (!expression) return undefined;
	const candidate = unwrap(expression);
	return ts.isCallExpression(candidate) && !candidate.questionDotToken ? candidate : undefined;
}

function forwardsParameter(parameter: ts.ParameterDeclaration, argument: ts.Expression): boolean {
	if (!ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken)
		return false;
	const value = unwrap(argument);
	return ts.isIdentifier(value) && value.text === parameter.name.text;
}

/** Syntactic argument preservation, NOT semantic redundancy or a resolved call edge. */
export function forwarderAt(file: FileSyntax, fn: FunctionFacts): Forwarder | undefined {
	const node = fn.node;
	if (!ts.isFunctionLike(node) || !("body" in node) || !node.body) return undefined;
	const call = returnedCall(node.body);
	if (!call || call.arguments.length !== node.parameters.length) return undefined;
	if (
		!call.arguments.every((arg, i) => {
			const parameter = node.parameters[i];
			return parameter !== undefined && forwardsParameter(parameter, arg);
		})
	)
		return undefined;
	return {
		path: file.path,
		range: fn.range,
		name: fn.name,
		target: call.expression.getText(file.sourceFile),
		parameters: node.parameters.length,
		isAsync: ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false,
	};
}

function caseValue(expression: ts.Expression): string | undefined {
	const value = unwrap(expression);
	if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))
		return `string:${JSON.stringify(value.text)}`;
	if (ts.isNumericLiteral(value)) return `number:${Number(value.text)}`;
	return undefined;
}

function dispatchAt(file: FileSyntax, node: ts.SwitchStatement): Dispatch | undefined {
	const cases: string[] = [];
	for (const clause of node.caseBlock.clauses) {
		if (!ts.isCaseClause(clause)) continue;
		const value = caseValue(clause.expression);
		if (value === undefined) return undefined; // Mixed/dynamic domains are outside this probe.
		cases.push(value);
	}
	const unique = [...new Set(cases)].sort();
	if (unique.length < 2) return undefined;
	return {
		path: file.path,
		range: rangeAt(file.sourceFile, node.getStart(file.sourceFile), node.getEnd()),
		expression: node.expression.getText(file.sourceFile),
		cases: unique,
		hasDefault: node.caseBlock.clauses.some(ts.isDefaultClause),
	};
}

/** Walk the AST once, including top-level switches and nested functions exactly once. */
export function dispatchesIn(file: FileSyntax): Dispatch[] {
	const result: Dispatch[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isSwitchStatement(node)) {
			const dispatch = dispatchAt(file, node);
			if (dispatch) result.push(dispatch);
		}
		ts.forEachChild(node, visit);
	};
	visit(file.sourceFile);
	return result;
}
