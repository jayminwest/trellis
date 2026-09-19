/** Inclusive line context only, independent of token matching and score accounting. */
import type { LineOverlap } from "../contract/line-overlap.ts";
import type { CloneMember } from "./duplication.ts";

/** O(n log n) time and O(n) output: never enumerate a quadratic set of member pairs. */
export function cloneLineOverlap(members: readonly CloneMember[]): LineOverlap {
	const ordered = members
		.map((member, index) => ({ ...member, index }))
		.sort(
			(a, b) =>
				(a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
				a.range.start.line - b.range.start.line ||
				a.range.end.line - b.range.end.line ||
				a.index - b.index,
		);
	const memberIndexes: number[] = [];
	const events = new Map<string, Map<number, number>>();
	let path = "";
	let furthestEnd = 0;
	for (const [i, member] of ordered.entries()) {
		if (path !== member.path) {
			path = member.path;
			furthestEnd = 0;
		}
		const start = member.range.start.line;
		const end = member.range.end.line;
		const next = ordered[i + 1];
		if (start <= furthestEnd || (next?.path === path && next.range.start.line <= end)) {
			memberIndexes.push(member.index);
		}
		furthestEnd = Math.max(furthestEnd, end);
		let fileEvents = events.get(path);
		if (!fileEvents) {
			fileEvents = new Map();
			events.set(path, fileEvents);
		}
		fileEvents.set(start, (fileEvents.get(start) ?? 0) + 1);
		fileEvents.set(end + 1, (fileEvents.get(end + 1) ?? 0) - 1);
	}
	const spans = overlapSpans(events);
	return {
		version: 1,
		overlaps: spans.length > 0,
		memberIndexes: memberIndexes.sort((a, b) => a - b),
		spans,
	};
}

function overlapSpans(events: ReadonlyMap<string, Map<number, number>>): LineOverlap["spans"] {
	const spans: LineOverlap["spans"] = [];
	for (const [path, fileEvents] of events) {
		let active = 0;
		let startLine = 0;
		for (const [line, delta] of [...fileEvents].sort(([a], [b]) => a - b)) {
			const previous = active;
			active += delta;
			if (previous < 2 && active >= 2) startLine = line;
			if (previous >= 2 && active < 2) spans.push({ path, startLine, endLine: line - 1 });
		}
	}
	return spans;
}
