import { describe, expect, test } from "bun:test";
import { band, clampLevel } from "./band.ts";

describe("band", () => {
	test("maps every 20-pt band interior to its level", () => {
		expect(band(0.1)).toBe(1);
		expect(band(0.3)).toBe(2);
		expect(band(0.5)).toBe(3);
		expect(band(0.7)).toBe(4);
		expect(band(0.9)).toBe(5);
	});

	test("places each band boundary in the higher band (lower-inclusive)", () => {
		expect(band(0.2)).toBe(2);
		expect(band(0.4)).toBe(3);
		expect(band(0.6)).toBe(4);
		expect(band(0.8)).toBe(5);
	});

	test("floors 0 to L1 and caps 1 to L5", () => {
		expect(band(0)).toBe(1);
		expect(band(1)).toBe(5);
	});

	test("folds NaN to the floor rather than banding it high", () => {
		expect(band(Number.NaN)).toBe(1);
	});
});

describe("clampLevel", () => {
	test("returns the lower of the two levels", () => {
		expect(clampLevel(5, 3)).toBe(3);
		expect(clampLevel(2, 4)).toBe(2);
	});

	test("is a no-op when coverage band is at or above the pass-rate band", () => {
		expect(clampLevel(4, 5)).toBe(4);
		expect(clampLevel(3, 3)).toBe(3);
	});
});
