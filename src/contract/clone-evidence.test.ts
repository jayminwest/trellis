import { describe, expect, test } from "bun:test";
import {
	CLONE_MATCH_MODES,
	type CloneEvidence,
	type CloneLocation,
	cloneEvidenceSchema,
	compareCloneLocations,
	groupMatchModeSchema,
} from "./clone-evidence.ts";

const location = (path: string, startLine: number, endLine: number): CloneLocation => ({
	path,
	range: { start: { line: startLine }, end: { line: endLine } },
});

const pair: CloneEvidence = {
	kind: "pair",
	matchMode: "normalized",
	members: [location("src/a.ts", 3, 17), location("src/b.ts", 5, 19)],
};

const group: CloneEvidence = {
	kind: "group",
	matchMode: "exact",
	members: [location("src/a.ts", 3, 17), location("src/b.ts", 5, 19), location("src/c.ts", 1, 15)],
};

describe("cloneEvidenceSchema", () => {
	test("round-trips a pair and a group as distinct evidence kinds", () => {
		expect(cloneEvidenceSchema.parse(pair)).toEqual(pair);
		expect(cloneEvidenceSchema.parse(group)).toEqual(group);
		expect(CLONE_MATCH_MODES).toEqual(["exact", "normalized", "near"]);
	});

	test("rejects a pair with identical members", () => {
		const result = cloneEvidenceSchema.safeParse({
			...pair,
			members: [location("src/a.ts", 3, 17), location("src/a.ts", 3, 17)],
		});
		expect(result.success).toBe(false);
	});

	test("rejects a pair out of deterministic location order", () => {
		const result = cloneEvidenceSchema.safeParse({
			...pair,
			members: [location("src/b.ts", 5, 19), location("src/a.ts", 3, 17)],
		});
		expect(result.success).toBe(false);
	});

	test("rejects a pair member with an invalid range", () => {
		const result = cloneEvidenceSchema.safeParse({
			...pair,
			members: [
				{ path: "src/a.ts", range: { start: { line: 17 }, end: { line: 3 } } },
				location("src/b.ts", 5, 19),
			],
		});
		expect(result.success).toBe(false);
	});

	test("rejects a group with a near match mode (nontransitive similarity)", () => {
		expect(groupMatchModeSchema.safeParse("near").success).toBe(false);
		const result = cloneEvidenceSchema.safeParse({ ...group, matchMode: "near" });
		expect(result.success).toBe(false);
	});

	test("rejects a group with fewer than two members", () => {
		const result = cloneEvidenceSchema.safeParse({ ...group, members: [group.members[0]] });
		expect(result.success).toBe(false);
	});

	test("rejects a group with duplicate or unsorted members", () => {
		expect(
			cloneEvidenceSchema.safeParse({
				...group,
				members: [
					location("src/c.ts", 1, 15),
					location("src/a.ts", 3, 17),
					location("src/b.ts", 5, 19),
				],
			}).success,
		).toBe(false);
		expect(
			cloneEvidenceSchema.safeParse({
				...group,
				members: [
					location("src/a.ts", 3, 17),
					location("src/a.ts", 3, 17),
					location("src/b.ts", 5, 19),
				],
			}).success,
		).toBe(false);
	});

	test("rejects an unknown evidence kind", () => {
		const result = cloneEvidenceSchema.safeParse({ ...pair, kind: "cluster" });
		expect(result.success).toBe(false);
	});
});

describe("compareCloneLocations", () => {
	test("orders by path, then start line, then start column, then end line", () => {
		expect(
			compareCloneLocations(location("src/a.ts", 3, 9), location("src/b.ts", 1, 2)),
		).toBeLessThan(0);
		expect(
			compareCloneLocations(location("src/a.ts", 3, 9), location("src/a.ts", 4, 9)),
		).toBeLessThan(0);
		expect(
			compareCloneLocations(
				{ path: "src/a.ts", range: { start: { line: 3, column: 2 }, end: { line: 9 } } },
				{ path: "src/a.ts", range: { start: { line: 3, column: 5 }, end: { line: 9 } } },
			),
		).toBeLessThan(0);
		expect(
			compareCloneLocations(
				{ path: "src/a.ts", range: { start: { line: 3, column: 5 }, end: { line: 8 } } },
				{ path: "src/a.ts", range: { start: { line: 3, column: 5 }, end: { line: 9 } } },
			),
		).toBeLessThan(0);
		expect(compareCloneLocations(location("src/a.ts", 3, 9), location("src/a.ts", 3, 9))).toBe(0);
		expect(
			compareCloneLocations(location("src/b.ts", 1, 2), location("src/a.ts", 3, 9)),
		).toBeGreaterThan(0);
	});
});
