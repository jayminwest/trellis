import { describe, expect, test } from "bun:test";
import {
	aggregateMass,
	ccDistribution,
	functionMass,
	isEroded,
	nearestRank,
	packageAggregate,
	roundTo,
} from "./erosion.ts";
import { EROSION_CC_THRESHOLD } from "./types.ts";

describe("functionMass", () => {
	test("is CC times the square root of SLOC", () => {
		expect(functionMass(10, 25)).toBe(50); // 10 × √25
		expect(functionMass(7, 9)).toBe(21); // 7 × √9
		expect(functionMass(1, 1)).toBe(1);
	});

	test("is zero when either factor is zero", () => {
		expect(functionMass(0, 25)).toBe(0);
		expect(functionMass(5, 0)).toBe(0);
	});
});

describe("isEroded", () => {
	test("triggers strictly above the documented threshold", () => {
		expect(EROSION_CC_THRESHOLD).toBe(10); // SPEC §5.2 "CC > 10"
		expect(isEroded(10)).toBe(false);
		expect(isEroded(11)).toBe(true);
	});
});

describe("roundTo", () => {
	test("rounds to the requested decimals deterministically", () => {
		expect(roundTo(1.23456, 3)).toBe(1.235);
		expect(roundTo(1 / 3, 6)).toBe(0.333333);
		expect(roundTo(2, 3)).toBe(2);
	});
});

describe("nearestRank", () => {
	test("picks the value at rank ceil(p/100 × n)", () => {
		const sorted = [1, 2, 3, 4];
		expect(nearestRank(sorted, 50)).toBe(2); // rank ceil(2.0) = 2
		expect(nearestRank(sorted, 90)).toBe(4); // rank ceil(3.6) = 4
		expect(nearestRank(sorted, 100)).toBe(4);
		expect(nearestRank([7], 50)).toBe(7);
	});

	test("is null for an empty sample", () => {
		expect(nearestRank([], 50)).toBeNull();
	});
});

describe("ccDistribution", () => {
	test("sorts the sample and reports p50/p90/max", () => {
		expect(ccDistribution([4, 1, 3, 2])).toEqual({ p50: 2, p90: 4, max: 4 });
		expect(ccDistribution([5])).toEqual({ p50: 5, p90: 5, max: 5 });
	});

	test("is null for a function-free scope", () => {
		expect(ccDistribution([])).toBeNull();
	});
});

describe("aggregateMass", () => {
	test("sums masses and derives the share from the sums", () => {
		// 33 of 36 total mass is eroded → share 33/36, not an averaged percentage.
		const aggregate = aggregateMass(2, 18, [
			{ mass: 33, eroded: true },
			{ mass: 3, eroded: false },
		]);
		expect(aggregate).toEqual({
			files: 2,
			sloc: 18,
			functionCount: 2,
			mass: 36,
			erodedMass: 33,
			erodedCount: 1,
			erodedShare: 33 / 36,
		});
	});

	test("gives a function-free scope finite zeros and a null share", () => {
		expect(aggregateMass(1, 12, [])).toEqual({
			files: 1,
			sloc: 12,
			functionCount: 0,
			mass: 0,
			erodedMass: 0,
			erodedCount: 0,
			erodedShare: null,
		});
	});
});

describe("packageAggregate", () => {
	test("carries the package path alongside the summed masses", () => {
		const aggregate = packageAggregate("packages/big", 1, 9, [{ mass: 33, eroded: true }]);
		expect(aggregate.packagePath).toBe("packages/big");
		expect(aggregate.mass).toBe(33);
		expect(aggregate.erodedShare).toBe(1);
	});
});
