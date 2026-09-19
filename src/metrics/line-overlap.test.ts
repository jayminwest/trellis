import { describe, expect, test } from "bun:test";
import { lineOverlapSchema } from "../contract/line-overlap.ts";
import type { CloneMember } from "./duplication.ts";
import { cloneLineOverlap } from "./line-overlap.ts";

function member(path: string, start: number, end: number): CloneMember {
	return {
		path,
		range: { start: { line: start }, end: { line: end } },
		tokenCount: 100,
		lineCount: end - start + 1,
	};
}

describe("cloneLineOverlap", () => {
	test("distinguishes disjoint members and different files from inclusive boundary overlap", () => {
		const disjoint = [member("a.ts", 1, 3), member("a.ts", 4, 6), member("b.ts", 1, 6)];
		expect(cloneLineOverlap(disjoint)).toEqual({
			version: 1,
			overlaps: false,
			memberIndexes: [],
			spans: [],
		});
		expect(cloneLineOverlap([member("a.ts", 1, 3), member("a.ts", 3, 6)])).toEqual({
			version: 1,
			overlaps: true,
			memberIndexes: [0, 1],
			spans: [{ path: "a.ts", startLine: 3, endLine: 3 }],
		});
	});

	test("unions multiply covered spans and retains all affected member indexes", () => {
		const members = [
			member("b.ts", 1, 4),
			member("a.ts", 8, 15),
			member("a.ts", 1, 10),
			member("a.ts", 3, 4),
			member("a.ts", 9, 12),
			member("b.ts", 4, 7),
			member("a.ts", 20, 23),
		];
		const evidence = cloneLineOverlap(members);
		expect(lineOverlapSchema.parse(evidence)).toEqual({
			version: 1,
			overlaps: true,
			memberIndexes: [0, 1, 2, 3, 4, 5],
			spans: [
				{ path: "a.ts", startLine: 3, endLine: 4 },
				{ path: "a.ts", startLine: 8, endLine: 12 },
				{ path: "b.ts", startLine: 4, endLine: 4 },
			],
		});
		expect(cloneLineOverlap([...members].reverse()).spans).toEqual(evidence.spans);
	});

	test("keeps dense multi-member evidence linear in output size", () => {
		const evidence = cloneLineOverlap(
			Array.from({ length: 10000 }, (_, i) => member("a.ts", i + 1, i + 20000)),
		);
		expect(evidence.memberIndexes).toHaveLength(10000);
		expect(evidence.spans).toEqual([{ path: "a.ts", startLine: 2, endLine: 29998 }]);
	});
});
