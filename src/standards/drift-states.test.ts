import { describe, expect, test } from "bun:test";
import { failingDriftCount, hasFailingDrift } from "./drift-states.ts";

describe("drift policy", () => {
	test("accepts matched files, approved differences and extra files", () => {
		const summary = { match: 4, "allowed-delta": 2, extra: 3, drift: 0, missing: 0 };
		expect(hasFailingDrift(summary)).toBe(false);
		expect(failingDriftCount(summary)).toBe(0);
	});

	test("fails when a required canonical file is missing", () => {
		const summary = { match: 4, "allowed-delta": 0, extra: 0, drift: 0, missing: 1 };
		expect(hasFailingDrift(summary)).toBe(true);
		expect(failingDriftCount(summary)).toBe(1);
	});

	test("counts only divergent and missing files in a mixed result", () => {
		const summary = { match: 5, "allowed-delta": 2, extra: 4, drift: 2, missing: 3 };
		expect(hasFailingDrift(summary)).toBe(true);
		expect(failingDriftCount(summary)).toBe(5);
	});
});
