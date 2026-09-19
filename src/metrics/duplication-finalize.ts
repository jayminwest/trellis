/** Bounded materialization and containment, preserving the existing finalizer.
 * All members of a group have equal token length, so none strictly contains
 * another. Across eligible groups, a sorted per-file sweep answers strict
 * containment in O(m log m), without nested group/member scans.
 */
import {
	type CloneGroup,
	type CloneMember,
	DUPLICATION_MIN_LINES,
	type TokenStream,
} from "./duplication.ts";
import type { RawGroup, RawMember } from "./duplication-groups.ts";
import type { DuplicationWork } from "./duplication-work.ts";

interface Located extends RawMember {
	path: string;
	startLine: number;
	endLine: number;
	owner: number;
}
interface LocatedGroup {
	length: number;
	members: Located[];
	hasUncontained: boolean;
}

function locateMembers(
	group: RawGroup,
	streams: readonly TokenStream[],
	fileStart: Uint32Array,
	owner: number,
	work: DuplicationWork,
): Located[] {
	const members: Located[] = [];
	for (const member of group.members.values()) {
		work.charge(6);
		const stream = streams[member.file];
		const offset = fileStart[member.file] ?? 0;
		const startLine = stream?.startLines[member.start - offset] ?? 1;
		const endLine = stream?.endLines[member.end - offset - 1] ?? startLine;
		if (stream === undefined || endLine - startLine + 1 < DUPLICATION_MIN_LINES) continue;
		work.retainOccurrence();
		members.push({ ...member, path: stream.path, startLine, endLine, owner });
	}
	return members;
}

function locate(
	raw: Map<number, RawGroup[]>,
	streams: readonly TokenStream[],
	fileStart: Uint32Array,
	work: DuplicationWork,
): LocatedGroup[] {
	const groups: LocatedGroup[] = [];
	for (const sameLength of raw.values()) {
		work.charge();
		for (const group of sameLength) {
			work.retainGroup();
			const members = locateMembers(group, streams, fileStart, groups.length, work);
			if (members.length >= 2)
				groups.push({ length: group.length, members, hasUncontained: false });
		}
	}
	return groups;
}

function markSurvivors(groups: LocatedGroup[], work: DuplicationWork): void {
	const ordered: Located[] = [];
	for (const group of groups) {
		work.charge();
		for (const member of group.members) {
			work.reserve(2);
			ordered.push(member);
		}
	}
	ordered.sort((a, b) => {
		work.charge(3);
		return a.file - b.file || a.start - b.start || b.end - a.end;
	});
	let file = -1;
	let start = -1;
	let priorEnd = -1;
	let sameStartEnd = -1;
	for (const member of ordered) {
		work.charge(5);
		if (member.file !== file) {
			file = member.file;
			start = -1;
			priorEnd = -1;
			sameStartEnd = -1;
		}
		if (member.start !== start) {
			priorEnd = Math.max(priorEnd, sameStartEnd);
			sameStartEnd = -1;
			start = member.start;
		}
		const group = groups[member.owner];
		if (group !== undefined && priorEnd < member.end && sameStartEnd <= member.end)
			group.hasUncontained = true;
		sameStartEnd = Math.max(sameStartEnd, member.end);
	}
	work.release(ordered.length * 2);
}

function memberOrder(a: CloneMember, b: CloneMember): number {
	if (a.path !== b.path) return a.path < b.path ? -1 : 1;
	return a.range.start.line - b.range.start.line || a.range.end.line - b.range.end.line;
}

function project(group: LocatedGroup, work: DuplicationWork): CloneGroup {
	work.retainGroup();
	const members: CloneMember[] = [];
	for (const member of group.members) {
		work.retainOccurrence();
		members.push({
			path: member.path,
			range: { start: { line: member.startLine }, end: { line: member.endLine } },
			tokenCount: group.length,
			lineCount: member.endLine - member.startLine + 1,
		});
	}
	members.sort((a, b) => {
		work.charge();
		return memberOrder(a, b);
	});
	return { id: "", tokenCount: group.length, members };
}

function groupOrder(a: CloneGroup, b: CloneGroup): number {
	const firstA = a.members[0];
	const firstB = b.members[0];
	if (firstA === undefined || firstB === undefined) return 0;
	return (
		memberOrder(firstA, firstB) ||
		b.tokenCount - a.tokenCount ||
		b.members.length - a.members.length
	);
}

export function finalizeCandidateGroups(
	raw: Map<number, RawGroup[]>,
	streams: readonly TokenStream[],
	fileStart: Uint32Array,
	work: DuplicationWork,
): CloneGroup[] {
	work.enter("materialization");
	const located = locate(raw, streams, fileStart, work);
	work.enter("finalization");
	markSurvivors(located, work);
	const groups: CloneGroup[] = [];
	for (const group of located) {
		work.charge();
		if (group.hasUncontained) groups.push(project(group, work));
	}
	groups.sort((a, b) => {
		work.charge();
		return groupOrder(a, b);
	});
	for (const [index, group] of groups.entries()) {
		work.charge();
		group.id = `clone-group-${index + 1}`;
	}
	work.checkpoint();
	return groups;
}
