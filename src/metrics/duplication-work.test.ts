import { describe, expect, test } from "bun:test";
import { DUPLICATION_LIMITS, DuplicationLimitError, DuplicationWork } from "./duplication-work.ts";

describe("DuplicationWork", () => {
	test("rejects invalid and above-ceiling limits instead of disabling guards", () => {
		for (const [key, ceiling] of Object.entries(DUPLICATION_LIMITS)) {
			for (const value of [-1, 0.5, NaN, Infinity, ceiling + 1]) {
				expect(() => new DuplicationWork({ [key]: value })).toThrow(RangeError);
			}
		}
		expect(() => new DuplicationWork({ maxMatchWork: 2, phaseLimits: { index: 3 } })).toThrow(
			RangeError,
		);
	});

	test("charges shared work before operations and keeps separate phase counters", () => {
		const work = new DuplicationWork({ maxMatchWork: 3 });
		work.charge(2);
		work.enter("extraction");
		work.charge();
		expect(work.total).toBe(3);
		expect(work.counts.input).toBe(2);
		expect(work.counts.extraction).toBe(1);
		expect(() => work.charge()).toThrow(DuplicationLimitError);
		expect(work.total).toBe(3);
	});

	test("reserves and releases live numeric cells before allocating", () => {
		const work = new DuplicationWork({ maxWorkingCells: 3 });
		expect(work.array(3)).toEqual(new Uint32Array(3));
		expect(() => work.array(1)).toThrow(DuplicationLimitError);
		work.release(2);
		expect(work.array(2).length).toBe(2);
		expect(work.peakCells).toBe(3);
		expect(work.liveCells).toBe(3);
	});

	test("bounds cumulative retained groups and member occurrences", () => {
		const work = new DuplicationWork({ maxGroups: 1, maxOccurrences: 2 });
		work.enter("materialization");
		work.retainGroup();
		work.retainOccurrence();
		work.retainOccurrence();
		expect(() => work.retainGroup()).toThrow(DuplicationLimitError);
		expect(() => work.retainOccurrence()).toThrow(DuplicationLimitError);
		expect(work.groups).toBe(1);
		expect(work.occurrences).toBe(2);
	});

	test("checks cancellation before phase entry and within 1024 charged units", () => {
		const cancelled = new DuplicationWork({ isCancelled: () => true });
		expect(() => cancelled.enter("input")).toThrow(DuplicationLimitError);
		expect(cancelled.total).toBe(0);
		let isCancelled = false;
		const work = new DuplicationWork({ isCancelled: () => isCancelled });
		work.enter("index");
		work.charge();
		isCancelled = true;
		for (let i = 0; i < 1022; i += 1) work.charge();
		expect(() => work.charge()).toThrow(DuplicationLimitError);
		expect(work.total).toBe(1023);
	});
});
