/**
 * Function inventory over one shared parse (SPEC §5.1).
 *
 * Inventoried: function declarations, function expressions, arrow functions,
 * methods, constructors, and get/set accessors — each exactly once, in
 * pre-order (a function always precedes its nested functions in the result).
 *
 * **Nesting / attribution rule** (binding, SPEC §5.1): every function is
 * attributed to its innermost enclosing function via `depth`/`parentIndex`,
 * and a nested function's body is *never* part of the parent's measurable
 * subtree. Analyzers enforce this mechanically by walking parents with
 * {@link walkOwnNodes}, which descends everywhere except into nested
 * function-likes — those are yielded once, as opaque leaves.
 *
 * **Overload rule**: a function-like node without a body (overload
 * signatures, `declare function`, abstract methods) is not an inventory
 * entry. Signatures are counted per *container child list* (a module's
 * statements, a class's members, …): each same-named signature bumps the
 * count the following implementation records in `overloadSignatures`, and
 * every signature also bumps the file-level `signatureCount`. Interface and
 * type-literal members (`MethodSignature`, …) are not function-likes at all
 * and are ignored — they are types, not callable implementations.
 */
import ts from "typescript";
import { rangeAt } from "./parse.ts";
import type { FunctionFacts, FunctionKind } from "./types.ts";

/** The `ts.SyntaxKind` → inventory-kind mapping for body-bearing function-likes. */
const FUNCTION_LIKE_KINDS: ReadonlyMap<ts.SyntaxKind, FunctionKind> = new Map([
	[ts.SyntaxKind.FunctionDeclaration, "function-declaration"],
	[ts.SyntaxKind.FunctionExpression, "function-expression"],
	[ts.SyntaxKind.ArrowFunction, "arrow-function"],
	[ts.SyntaxKind.MethodDeclaration, "method"],
	[ts.SyntaxKind.Constructor, "constructor"],
	[ts.SyntaxKind.GetAccessor, "get-accessor"],
	[ts.SyntaxKind.SetAccessor, "set-accessor"],
]);

/** A function-like node in the compiler's own typing (body optional at the type level). */
type FunctionLikeNode =
	| ts.FunctionDeclaration
	| ts.FunctionExpression
	| ts.ArrowFunction
	| ts.MethodDeclaration
	| ts.ConstructorDeclaration
	| ts.GetAccessorDeclaration
	| ts.SetAccessorDeclaration;

/** Narrow `node` to a function-like kind the inventory recognizes. */
function asFunctionLike(node: ts.Node): { kind: FunctionKind; fn: FunctionLikeNode } | null {
	const kind = FUNCTION_LIKE_KINDS.get(node.kind);
	return kind === undefined ? null : { kind, fn: node as FunctionLikeNode };
}

/** Static text of a property/binding name; `undefined` for computed names. */
function propertyNameText(name: ts.PropertyName | undefined): string | undefined {
	if (name === undefined) return undefined;
	if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
	if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
	return undefined; // computed names have no static text
}

/** Contextual name for an expression/arrow from its parent (variable declarator, property assignment). */
function contextualName(node: ts.Node): string | undefined {
	const parent = node.parent;
	if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
	if (ts.isPropertyAssignment(parent)) return propertyNameText(parent.name);
	return undefined;
}

/** Name + origin for one inventoried function, per the documented naming rule. */
function nameOf(
	kind: FunctionKind,
	fn: FunctionLikeNode,
): { name: string; nameOrigin: FunctionFacts["nameOrigin"] } {
	if (kind === "constructor") return { name: "constructor", nameOrigin: "declared" };
	if (!ts.isArrowFunction(fn)) {
		const declared = propertyNameText(fn.name);
		if (declared !== undefined) return { name: declared, nameOrigin: "declared" };
	}
	const contextual = contextualName(fn);
	if (contextual !== undefined) return { name: contextual, nameOrigin: "contextual" };
	return { name: "(anonymous)", nameOrigin: "anonymous" };
}

/** Mutable state threaded through the inventory walk. */
interface CollectState {
	sourceFile: ts.SourceFile;
	facts: FunctionFacts[];
	/** Indices into `facts`: the enclosing functions, outermost first. */
	stack: number[];
	signatures: number;
}

/** Build the facts entry for one body-bearing function and link it to its parent. */
function addFunction(
	state: CollectState,
	pending: ReadonlyMap<string, number>,
	kind: FunctionKind,
	fn: FunctionLikeNode,
	body: ts.Node,
): void {
	const { name, nameOrigin } = nameOf(kind, fn);
	const parentIndex =
		state.stack.length === 0 ? null : (state.stack[state.stack.length - 1] ?? null);
	state.facts.push({
		kind,
		name,
		nameOrigin,
		node: fn,
		range: rangeAt(state.sourceFile, fn.getStart(state.sourceFile), fn.getEnd()),
		bodyRange: rangeAt(state.sourceFile, body.getStart(state.sourceFile), body.getEnd()),
		depth: state.stack.length,
		parentIndex,
		overloadSignatures: pending.get(name) ?? 0,
	});
}

/**
 * Visit one container's children. `pending` counts bodiless signatures seen
 * so far *in this child list* (a module's statements, a class's members, …);
 * each implementation consumes the count attached to its name, and every
 * child list gets a fresh map, so a class's overloads never mix with the
 * enclosing scope's.
 */
function visitChildren(state: CollectState, node: ts.Node): void {
	const pending = new Map<string, number>();
	for (const child of node.getChildren(state.sourceFile)) {
		const match = asFunctionLike(child);
		if (match === null) {
			visitChildren(state, child);
			continue;
		}
		const body: ts.Node | undefined = match.fn.body;
		if (body === undefined) {
			// Bodiless overload/declare/abstract signature — never inventoried.
			state.signatures += 1;
			const key = nameOf(match.kind, match.fn).name;
			pending.set(key, (pending.get(key) ?? 0) + 1);
			continue;
		}
		addFunction(state, pending, match.kind, match.fn, body);
		state.stack.push(state.facts.length - 1);
		visitChildren(state, child);
		state.stack.pop();
	}
}

/** The function inventory of one parsed file, plus its bodiless-signature count. */
export interface FileFunctions {
	functions: FunctionFacts[];
	signatureCount: number;
}

/**
 * Inventory every body-bearing function in `sourceFile` (see the module
 * docblock for the nesting and overload rules). Runs over the shared parse —
 * it never re-reads or re-parses the file.
 */
export function collectFunctions(sourceFile: ts.SourceFile): FileFunctions {
	const state: CollectState = { sourceFile, facts: [], stack: [], signatures: 0 };
	visitChildren(state, sourceFile);
	return { functions: state.facts, signatureCount: state.signatures };
}

/**
 * Call `visit` for every node in `fn`'s **own** subtree: the function node
 * itself and everything inside it, except that a nested function-like node is
 * yielded once and *not* descended into. This is the mechanical form of the
 * attribution rule — a parent's analyzer can never accidentally absorb a
 * nested function's branches (SPEC §5.1).
 */
export function walkOwnNodes(fn: FunctionFacts, visit: (node: ts.Node) => void): void {
	const sourceFile = fn.node.getSourceFile();
	const walk = (node: ts.Node): void => {
		visit(node);
		if (node !== fn.node && asFunctionLike(node) !== null) return;
		for (const child of node.getChildren(sourceFile)) walk(child);
	};
	walk(fn.node);
}
