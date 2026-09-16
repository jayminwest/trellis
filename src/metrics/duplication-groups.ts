/**
 * Clone-group finalization (SPEC §5.3, trellis-6e4c) — folding raw matches
 * into the stable, deterministically ordered group list.
 *
 * The rules applied here (see the `duplication.ts` module docblock for the
 * full semantics):
 *
 * - members spanning fewer than {@link DUPLICATION_MIN_LINES} lines are
 *   dropped (the line minimum is per member);
 * - same-file token-contained members are dropped (a nested repeat is not
 *   a second copy);
 * - groups with fewer than two surviving members are dropped;
 * - a group whose every member is token-contained in members of other
 *   groups is **subsumed** and dropped — the shared region of two
 *   overlapping clones is not a third clone;
 * - survivors are sorted by location (never hash-map order) and assigned
 *   stable `clone-group-<n>` ids.
 */
import {
	type CloneGroup,
	type CloneMember,
	DUPLICATION_MIN_LINES,
	type TokenStream,
} from "./duplication.ts";

/** One raw match member: a half-open token range [`start`, `end`) in the concatenated stream. */
export interface RawMember {
	/** Index into the detection run's stream array. */
	file: number;
	start: number;
	end: number;
}

/** A raw group under construction: members sharing one content-identical run. */
export interface RawGroup {
	/** Tokens per member run. */
	length: number;
	/** Representative member for content verification. */
	rep: RawMember;
	/** Members keyed by `${file}:${start}` (dedup). */
	members: Map<string, RawMember>;
}

/** One member with resolved line information, ready for filtering and sorting. */
interface LocatedMember extends RawMember {
	path: string;
	startLine: number;
	endLine: number;
}

/** True when `inner` is strictly token-contained in `outer` (same file). */
function contains(outer: RawMember, inner: RawMember): boolean {
	return (
		outer.file === inner.file &&
		outer.start <= inner.start &&
		outer.end >= inner.end &&
		(outer.start < inner.start || outer.end > inner.end)
	);
}

/** Resolve raw members to located ones, applying the minimum-line and containment rules. */
function locateGroup(
	group: RawGroup,
	streams: readonly TokenStream[],
	fileStart: readonly number[],
): LocatedMember[] {
	const located: LocatedMember[] = [];
	for (const member of group.members.values()) {
		const stream = streams[member.file];
		if (stream === undefined) continue;
		const localStart = member.start - (fileStart[member.file] ?? 0);
		const localEnd = member.end - (fileStart[member.file] ?? 0) - 1;
		const startLine = stream.startLines[localStart] ?? 1;
		const endLine = stream.endLines[localEnd] ?? startLine;
		if (endLine - startLine + 1 < DUPLICATION_MIN_LINES) continue;
		located.push({ ...member, path: stream.path, startLine, endLine });
	}
	return located.filter(
		(member, index) =>
			!located.some((other, otherIndex) => otherIndex !== index && contains(other, member)),
	);
}

/** Deterministic member order: path, then start line, then end line. */
function byMember(a: CloneMember, b: CloneMember): number {
	if (a.path !== b.path) return a.path < b.path ? -1 : 1;
	if (a.range.start.line !== b.range.start.line) return a.range.start.line - b.range.start.line;
	return a.range.end.line - b.range.end.line;
}

/** Materialize one surviving group's members into sorted {@link CloneMember}s. */
function materializeGroup(group: {
	length: number;
	members: LocatedMember[];
}): Omit<CloneGroup, "id"> {
	return {
		tokenCount: group.length,
		members: group.members
			.map(
				(member): CloneMember => ({
					path: member.path,
					range: {
						start: { line: member.startLine },
						end: { line: member.endLine },
					},
					tokenCount: group.length,
					lineCount: member.endLine - member.startLine + 1,
				}),
			)
			.sort(byMember),
	};
}

/** Deterministic group order: first member's location, then token count, then copy count. */
function byGroup(a: Omit<CloneGroup, "id">, b: Omit<CloneGroup, "id">): number {
	const firstA = a.members[0];
	const firstB = b.members[0];
	if (firstA === undefined || firstB === undefined) return 0;
	const byLocation = byMember(firstA, firstB);
	if (byLocation !== 0) return byLocation;
	if (a.tokenCount !== b.tokenCount) return b.tokenCount - a.tokenCount;
	return b.members.length - a.members.length;
}

/**
 * Fold raw groups into the final deterministic group list (see the module
 * docblock for the rules). Subsumption is single-pass: strict containment
 * is transitive, so a group subsumed through a chain is subsumed directly
 * by the chain's largest group.
 */
export function finalizeGroups(
	byLength: Map<number, RawGroup[]>,
	streams: readonly TokenStream[],
	fileStart: readonly number[],
): CloneGroup[] {
	let groups = [...byLength.values()]
		.flat()
		.map((group) => ({
			length: group.length,
			members: locateGroup(group, streams, fileStart),
		}))
		.filter((group) => group.members.length >= 2);
	groups = groups.filter((group, index) =>
		group.members.some(
			(member) =>
				!groups.some(
					(other, otherIndex) =>
						otherIndex !== index && other.members.some((outer) => contains(outer, member)),
				),
		),
	);
	return groups
		.map(materializeGroup)
		.sort(byGroup)
		.map((group, index) => ({ id: `clone-group-${index + 1}`, ...group }));
}
