/** Bounded code-line union using the shared, unchanged line classification. */
import { classifyLines, type FileSyntax } from "../syntax/index.ts";
import type { CloneGroup } from "./duplication.ts";
import type { DuplicationWork } from "./duplication-work.ts";

interface LineInterval {
	start: number;
	end: number;
}

function intervalsByPath(groups: readonly CloneGroup[], work: DuplicationWork) {
	const paths = new Map<string, LineInterval[]>();
	for (const group of groups) {
		work.charge();
		for (const member of group.members) {
			work.retainOccurrence();
			const intervals = paths.get(member.path) ?? [];
			intervals.push({ start: member.range.start.line, end: member.range.end.line });
			paths.set(member.path, intervals);
		}
	}
	return paths;
}

function coveredLines(file: FileSyntax, intervals: LineInterval[], work: DuplicationWork): number {
	intervals.sort((a, b) => {
		work.charge();
		return a.start - b.start || b.end - a.end;
	});
	const kinds = classifyLines(file.sourceFile, work);
	let last = 0;
	let count = 0;
	for (const interval of intervals) {
		work.charge();
		const end = Math.min(interval.end, kinds.length);
		for (let line = Math.max(last + 1, interval.start); line <= end; line += 1) {
			work.charge();
			if (kinds[line - 1] === "code") count += 1;
		}
		last = Math.max(last, end);
	}
	work.release(kinds.length);
	return count;
}

export function accountCandidateLines(
	files: readonly FileSyntax[],
	groups: readonly CloneGroup[],
	work: DuplicationWork,
) {
	work.enter("finalization");
	const paths = intervalsByPath(groups, work);
	let codeLines = 0;
	let duplicatedLines = 0;
	for (const file of files) {
		work.charge();
		codeLines += file.lines.code;
		const intervals = paths.get(file.path);
		if (intervals !== undefined) duplicatedLines += coveredLines(file, intervals, work);
	}
	work.checkpoint();
	return {
		codeLines,
		duplicatedLines,
		density: codeLines === 0 ? null : duplicatedLines / codeLines,
	};
}
