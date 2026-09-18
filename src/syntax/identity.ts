/** Named lexical ancestry from the shared AST; no source offsets or ordinal identities. */
import ts from "typescript";
import {
	HOTSPOT_IDENTITY_VERSION,
	type HotspotIdentity,
	type IdentityScope,
} from "../contract/hotspot-identity.ts";
import type { FunctionFacts } from "./types.ts";

type AmbiguousIdentity = Extract<HotspotIdentity, { state: "ambiguous" }>;
export type FunctionIdentity =
	| Omit<Extract<HotspotIdentity, { state: "identified" }>, "sourceSet">
	| AmbiguousIdentity;
type Reason = AmbiguousIdentity["reason"];

interface Scope {
	parent?: Scope;
	component?: IdentityScope;
	reason?: Reason;
	children: Map<string, Scope[]>;
}

/** Direct bindings only: parentheses/assignments never manufacture a scope name. */
function bindingName(node: ts.Node): ts.PropertyName | ts.BindingName | undefined {
	const parent = node.parent;
	if (
		ts.isVariableDeclaration(parent) ||
		ts.isPropertyAssignment(parent) ||
		ts.isPropertyDeclaration(parent)
	) {
		return parent.initializer === node ? parent.name : undefined;
	}
	return undefined;
}

function namedScope(
	node: ts.Node,
	kind: IdentityScope["kind"],
	name: ts.PropertyName | ts.BindingName | undefined,
	missing: Reason,
): Pick<Scope, "component" | "reason"> {
	if (name === undefined || ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name))
		return { reason: missing };
	if (ts.isComputedPropertyName(name)) return { reason: "computed-name" };
	const owner =
		ts.isPropertyDeclaration(node.parent) || ts.isPropertyAssignment(node.parent)
			? node.parent
			: node;
	const isMember = ts.isClassLike(owner.parent) || ts.isObjectLiteralExpression(owner.parent);
	const isStatic =
		ts.canHaveModifiers(owner) &&
		ts.getModifiers(owner)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword);
	return {
		component: {
			kind,
			name: name.text,
			member: isMember ? (isStatic ? "static" : "instance") : "none",
		},
	};
}

function functionScope(
	fn: Pick<FunctionFacts, "kind" | "node">,
): Pick<Scope, "component" | "reason"> {
	const node = fn.node;
	if (ts.isConstructorDeclaration(node)) {
		return { component: { kind: fn.kind, name: "constructor", member: "instance" } };
	}
	const name =
		ts.isArrowFunction(node) || ts.isFunctionExpression(node)
			? bindingName(node)
			: (node as ts.FunctionDeclaration).name;
	return namedScope(node, fn.kind, name, "anonymous");
}

function containerScope(node: ts.Node): Pick<Scope, "component" | "reason"> | undefined {
	if (ts.isClassLike(node)) {
		return namedScope(node, "class", bindingName(node) ?? node.name, "unnamed-scope");
	}
	if (ts.isObjectLiteralExpression(node)) {
		return namedScope(node, "object", bindingName(node), "unnamed-scope");
	}
	if (ts.isModuleDeclaration(node))
		return namedScope(node, "namespace", node.name, "unnamed-scope");
	if (
		ts.isBlock(node) &&
		ts.isFunctionLike(node.parent) &&
		"body" in node.parent &&
		node.parent.body === node
	)
		return undefined;
	if (
		ts.isBlock(node) ||
		ts.isIterationStatement(node, false) ||
		ts.isCatchClause(node) ||
		ts.isCaseBlock(node) ||
		ts.isClassStaticBlockDeclaration(node)
	) {
		return { reason: "block-scope" };
	}
	return undefined;
}

/** Register all siblings before resolving ancestry, so collisions taint descendants too. */
function addScope(parent: Scope, description: Pick<Scope, "component" | "reason">): Scope {
	const scope: Scope = { parent, ...description, children: new Map() };
	if (scope.component !== undefined) {
		const { kind, name, member } = scope.component;
		const key = JSON.stringify([kind, name, member]);
		const peers = parent.children.get(key) ?? [];
		peers.push(scope);
		parent.children.set(key, peers);
		if (peers.length > 1) {
			scope.reason = "duplicate";
			const first = peers[0];
			if (first !== undefined) first.reason = "duplicate";
		}
	}
	return scope;
}

function resolveIdentity(scope: Scope): FunctionIdentity {
	const ancestry: Scope[] = [];
	for (
		let current: Scope | undefined = scope;
		current?.parent !== undefined;
		current = current.parent
	) {
		ancestry.push(current);
	}
	ancestry.reverse();
	const reason = ancestry.find((entry) => entry.reason !== undefined)?.reason;
	if (reason !== undefined)
		return { version: HOTSPOT_IDENTITY_VERSION, state: "ambiguous", reason };
	const components = ancestry.flatMap((entry) =>
		entry.component === undefined ? [] : [entry.component],
	);
	const component = components.pop();
	if (
		component === undefined ||
		component.kind === "class" ||
		component.kind === "object" ||
		component.kind === "namespace"
	) {
		throw new Error("function identity requires a function scope");
	}
	return {
		version: HOTSPOT_IDENTITY_VERSION,
		state: "identified",
		scopes: components,
		function: { ...component, kind: component.kind },
	};
}

/** Pure second traversal of the existing AST; all body-bearing functions remain in the inventory. */
export function collectFunctionIdentities(
	sourceFile: ts.SourceFile,
	functions: readonly Pick<FunctionFacts, "kind" | "node">[],
): Map<ts.Node, FunctionIdentity> {
	const facts = new Map(functions.map((fn) => [fn.node, fn]));
	const scopes = new Map<ts.Node, Scope>();
	const visit = (node: ts.Node, parent: Scope): void => {
		const fn = facts.get(node);
		const description = fn === undefined ? containerScope(node) : functionScope(fn);
		const scope = description === undefined ? parent : addScope(parent, description);
		if (fn !== undefined) scopes.set(node, scope);
		ts.forEachChild(node, (child) => visit(child, scope));
	};
	visit(sourceFile, { children: new Map() });
	return new Map([...scopes].map(([node, scope]) => [node, resolveIdentity(scope)]));
}
