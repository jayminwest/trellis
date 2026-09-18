/** Test-only line-union oracle, independent of the production interval accounting. */
import { classifyLines } from "../../syntax/sloc.ts";
import type { FileSyntax } from "../../syntax/types.ts";
import { collectTokenStream } from "../duplication.ts";
import { referenceDetection } from "./duplication-oracle.ts";

export function referenceScope(files: readonly FileSyntax[]) {
	const streams = files.map(collectTokenStream);
	const { groups } = referenceDetection(streams);
	let codeLines = 0;
	let duplicatedLines = 0;
	for (const file of files) {
		for (const [line, kind] of classifyLines(file.sourceFile).entries()) {
			if (kind !== "code") continue;
			codeLines++;
			if (
				groups.some((group) =>
					group.members.some(
						(member) =>
							member.path === file.path &&
							member.range.start.line <= line + 1 &&
							member.range.end.line >= line + 1,
					),
				)
			)
				duplicatedLines++;
		}
	}
	return {
		groups,
		codeLines,
		duplicatedLines,
		density: codeLines === 0 ? null : duplicatedLines / codeLines,
		tokenCount: streams.reduce((sum, stream) => sum + stream.kinds.length, 0),
	};
}
