import { describe, expect, test } from "bun:test";
import { detectClones } from "./duplication-detect.ts";
import { repeatedStreams } from "./tests/duplication-fixtures.ts";

describe("detectClones", () => {
	test("completes forty copies through the stable token-stream entry point", () => {
		const result = detectClones(repeatedStreams(40));
		expect(result.exhaustion).toBeNull();
		expect(result.tokenCount).toBe(9160);
		expect(result.groups).toHaveLength(1);
		expect(result.groups[0]?.tokenCount).toBe(229);
		expect(result.groups[0]?.members).toHaveLength(40);
	});

	test("locates lowered-budget failure without returning unfinished groups", () => {
		const result = detectClones(repeatedStreams(2), { maxTokens: 100, maxMatchWork: 1000 });
		expect(result.exhaustion).toEqual({ kind: "token-count", phase: "input", limit: 100 });
		expect(result.groups).toEqual([]);
	});
});
