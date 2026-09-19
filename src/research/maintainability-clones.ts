/** Syntax context only: neither shared responsibility nor safe extraction is inferred. */
import ts from "typescript";
import type { CloneGroup, CloneMember } from "../metrics/duplication.ts";
import type { FileSyntax } from "../syntax/index.ts";

function nodeFacts(node: ts.Node) {
	const call = ts.isCallExpression(node);
	const registration =
		call &&
		ts.isPropertyAccessExpression(node.expression) &&
		["option", "addOption", "hideHelp"].includes(node.expression.name.text);
	const decision =
		ts.isIfStatement(node) ||
		ts.isIterationStatement(node, false) ||
		ts.isSwitchStatement(node) ||
		ts.isConditionalExpression(node);
	const anchor =
		call && ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node;
	return { call, registration, decision, literal: ts.isLiteralExpression(node), anchor };
}

function memberContext(member: CloneMember, files: ReadonlyMap<string, FileSyntax>) {
	const file = files.get(member.path);
	if (!file || file.diagnostics.length) return { ...member, context: "unavailable" };
	let calls = 0;
	let registrations = 0;
	let decisions = 0;
	let literals = 0;
	const visit = (node: ts.Node): void => {
		const start = file.sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
		const end = file.sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
		if (
			end < member.range.start.line ||
			start > (member.range.end?.line ?? member.range.start.line)
		)
			return;
		const facts = nodeFacts(node);
		const line = file.sourceFile.getLineAndCharacterOfPosition(facts.anchor.getStart()).line + 1;
		if (
			line >= member.range.start.line &&
			line <= (member.range.end?.line ?? member.range.start.line)
		) {
			calls += Number(facts.call);
			registrations += Number(facts.registration);
			decisions += Number(facts.decision);
			literals += Number(facts.literal);
		}
		ts.forEachChild(node, visit);
	};
	visit(file.sourceFile);
	const context =
		registrations > 0 && decisions === 0
			? "registration-candidate"
			: decisions > 0
				? "control-flow"
				: "other-or-mixed";
	return { ...member, context, calls, registrations, decisions, literals };
}

export function contextualizeClones(groups: readonly CloneGroup[], files: readonly FileSyntax[]) {
	const byPath = new Map(files.map((file) => [file.path, file]));
	return groups.map((group) => ({
		...group,
		lineOverlap: group.members.some((left, i) =>
			group.members
				.slice(i + 1)
				.some(
					(right) =>
						left.path === right.path &&
						left.range.start.line <= (right.range.end?.line ?? right.range.start.line) &&
						right.range.start.line <= (left.range.end?.line ?? left.range.start.line),
				),
		),
		members: group.members.map((member) => memberContext(member, byPath)),
	}));
}
