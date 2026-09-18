/** Test-only exhaustive oracle. Never imported by an audit or offered as a backend. */
import type { CloneGroup, TokenStream } from "../duplication.ts";

export interface ReferenceMember {
	path: string;
	start: number;
	end: number;
}
export interface ReferenceGroup {
	tokens: number[];
	members: ReferenceMember[];
}

/** Enumerate every left-maximal pair and extend right without hashes or suffix indexes. */
function pairLength(a: TokenStream, p: number, b: TokenStream, q: number): number {
	if (p > 0 && q > 0 && a.kinds[p - 1] === b.kinds[q - 1]) return 0;
	let length = 0;
	while (
		p + length < a.kinds.length &&
		q + length < b.kinds.length &&
		a.kinds[p + length] === b.kinds[q + length]
	)
		length++;
	return length;
}

function collectPair(
	groups: Map<string, ReferenceGroup>,
	a: TokenStream,
	p: number,
	b: TokenStream,
	q: number,
): void {
	const length = pairLength(a, p, b, q);
	if (length < 100) return;
	const tokens = a.kinds.slice(p, p + length);
	const key = JSON.stringify(tokens);
	const group = groups.get(key) ?? { tokens, members: [] };
	for (const member of [
		{ path: a.path, start: p, end: p + length },
		{ path: b.path, start: q, end: q + length },
	]) {
		if (!group.members.some((old) => old.path === member.path && old.start === member.start))
			group.members.push(member);
	}
	groups.set(key, group);
}

function enumeratePair(
	groups: Map<string, ReferenceGroup>,
	a: TokenStream,
	b: TokenStream,
	sameFile: boolean,
): void {
	for (let p = 0; p <= a.kinds.length - 100; p++) {
		for (let q = sameFile ? p + 1 : 0; q <= b.kinds.length - 100; q++)
			collectPair(groups, a, p, b, q);
	}
}

/** At most 2,500 tokens: a small-input truth oracle, never a resource benchmark. */
export function exhaustiveGroups(streams: readonly TokenStream[]): ReferenceGroup[] {
	if (streams.reduce((sum, stream) => sum + stream.kinds.length, 0) > 2_500)
		throw new Error("oracle input exceeds 2500 tokens");
	if (new Set(streams.map((stream) => stream.sourceSet)).size > 1)
		throw new Error("oracle requires one source set");
	const groups = new Map<string, ReferenceGroup>();
	for (const [i, a] of streams.entries()) {
		for (const [j, b] of streams.entries()) {
			if (j < i) continue;
			enumeratePair(groups, a, b, i === j);
		}
	}
	return [...groups.values()];
}

/** Independent finalization: minimum span, strict token containment, then canonical locations. */
export function referenceDetection(streams: readonly TokenStream[]): {
	groups: CloneGroup[];
	raw: ReferenceGroup[];
} {
	const raw = exhaustiveGroups(streams);
	const streamByPath = new Map(streams.map((stream) => [stream.path, stream]));
	const location = (member: ReferenceMember) => {
		const stream = streamByPath.get(member.path);
		const start = stream?.startLines[member.start];
		const end = stream?.endLines[member.end - 1];
		if (start === undefined || end === undefined) throw new Error("oracle member has no location");
		return { start, end };
	};
	const contains = (outer: ReferenceMember, inner: ReferenceMember) =>
		outer.path === inner.path &&
		outer.start <= inner.start &&
		outer.end >= inner.end &&
		(outer.start < inner.start || outer.end > inner.end);
	const located = raw
		.map((group) => {
			const members = group.members.filter((member) => {
				const range = location(member);
				return range.end - range.start + 1 >= 3;
			});
			return {
				...group,
				members: members.filter((member) => !members.some((other) => contains(other, member))),
			};
		})
		.filter((group) => group.members.length >= 2);
	const surviving = located.filter((group) =>
		group.members.some(
			(member) =>
				!located.some(
					(other) => other !== group && other.members.some((outer) => contains(outer, member)),
				),
		),
	);
	const memberOrder = (a: CloneGroup["members"][number], b: CloneGroup["members"][number]) =>
		a.path < b.path
			? -1
			: a.path > b.path
				? 1
				: a.range.start.line - b.range.start.line || a.range.end.line - b.range.end.line;
	const groups = surviving
		.map(
			(group): CloneGroup => ({
				id: "",
				tokenCount: group.tokens.length,
				members: group.members
					.map((member) => {
						const { start, end } = location(member);
						return {
							path: member.path,
							tokenCount: group.tokens.length,
							lineCount: end - start + 1,
							range: { start: { line: start }, end: { line: end } },
						};
					})
					.sort(memberOrder),
			}),
		)
		.sort((a, b) => {
			const firstA = a.members[0];
			const firstB = b.members[0];
			if (firstA === undefined || firstB === undefined) throw new Error("oracle empty group");
			return (
				memberOrder(firstA, firstB) ||
				b.tokenCount - a.tokenCount ||
				b.members.length - a.members.length
			);
		});
	return { groups: groups.map((group, i) => ({ ...group, id: `clone-group-${i + 1}` })), raw };
}
