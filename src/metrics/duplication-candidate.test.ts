import { describe, expect, test } from "bun:test";
import { collectTokenStream } from "./duplication.ts";
import { detectCandidateClones, measureCandidateScope } from "./duplication-candidate.ts";
import {
	type DuplicationStop,
	DuplicationWork,
	type DuplicationWorkOptions,
} from "./duplication-work.ts";
import { referenceScope } from "./tests/duplication-accounting.ts";
import {
	repeatedSource,
	repeatedStreams,
	sourceFile,
	syntheticStream,
} from "./tests/duplication-fixtures.ts";
import { detectClones } from "./tests/legacy-duplication.ts";

function files(copies = 2) {
	return Array.from({ length: copies }, (_, i) => sourceFile(`${i}.ts`, repeatedSource(`fn${i}`)));
}

describe("bounded duplication candidate", () => {
	test("retains sorted diagnostic provenance for completed partial-parse measurements", () => {
		const input = [sourceFile("z.ts", "const z = ;"), sourceFile("a.ts", "const a = ;")];
		const result = measureCandidateScope(input);
		expect(result.exhaustion).toBeNull();
		expect(result.diagnosticFiles).toEqual(["a.ts", "z.ts"]);
		expect(result.totals?.codeLines).toBe(2);
	});

	test("matches complete legacy groups and independent code-line unions", () => {
		for (const input of [[], files(1), files(2), files(10)]) {
			const actual = measureCandidateScope(input);
			const reference = referenceScope(input);
			expect(actual.exhaustion).toBeNull();
			expect(actual.tokenCount).toBe(reference.tokenCount);
			expect(actual.totals).toEqual({
				codeLines: reference.codeLines,
				duplicatedLines: reference.duplicatedLines,
				density: reference.density,
			});
			expect(actual.groups).toEqual(
				detectClones(input.map((file) => collectTokenStream(file))).groups,
			);
		}
	});

	test("keeps comments, blanks and multiline literal classification unchanged", () => {
		const text = `${repeatedSource("a")}\nconst value = \`many\ncode\nlines\`;\n`;
		const input = [
			sourceFile("a.ts", text),
			sourceFile("b.ts", text.replace(" return x;", " // comment\n\n return x;")),
		];
		const reference = referenceScope(input);
		const actual = measureCandidateScope(input);
		expect(actual.exhaustion).toBeNull();
		expect(actual.totals?.duplicatedLines).toBe(reference.duplicatedLines);
		expect(actual.totals?.codeLines).toBe(reference.codeLines);
		expect(actual.groups).toEqual(reference.groups);
	});

	test("completes forty copies through collection, finalization and line counting", () => {
		const input = files(40);
		const result = measureCandidateScope(input);
		expect(result.exhaustion).toBeNull();
		expect(result.groups).toHaveLength(1);
		expect(result.groups[0]?.members).toHaveLength(40);
		expect(result.groups[0]?.tokenCount).toBe(229);
		expect(result.totals).toEqual({ codeLines: 1080, duplicatedLines: 1080, density: 1 });
		expect(result).toEqual(measureCandidateScope(input));
		for (const count of Object.values(result.work.phases)) expect(count).toBeGreaterThan(0);
	});

	test("returns located incomplete evidence for each phase without unvalidated groups", () => {
		for (const phase of [
			"input",
			"index",
			"extraction",
			"materialization",
			"finalization",
		] as const) {
			const options = { phaseLimits: { [phase]: 0 } };
			const result = measureCandidateScope(files(), options);
			expect(result.exhaustion).toEqual({ phase, kind: "phase-work", limit: 0 });
			expect(result.groups).toEqual([]);
			expect(result.totals).toBeNull();
			expect(result).toEqual(measureCandidateScope(files(), options));
		}
	});

	test("discards uncommitted groups when the last line-accounting work cannot complete", () => {
		const input = files(2);
		const full = measureCandidateScope(input);
		const result = measureCandidateScope(input, {
			phaseLimits: { finalization: full.work.phases.finalization - 1 },
		});
		expect(result.exhaustion?.phase).toBe("finalization");
		expect(result.groups).toEqual([]);
		expect(result.totals).toBeNull();
	});

	test("refuses token excess during collection and before combined input allocation", () => {
		const collected = measureCandidateScope(files(40), { maxTokens: 5 });
		expect(collected.exhaustion).toEqual({ phase: "input", kind: "maxTokens", limit: 5 });
		expect(collected.tokenCount).toBe(6);
		expect(collected.work.phases.index).toBe(0);
		const oversized = detectCandidateClones([syntheticStream("a", new Array(2_000_001).fill(1))]);
		expect(oversized.exhaustion?.kind).toBe("maxTokens");
		expect(oversized.work.peakCells).toBe(0);
		expect(oversized.groups).toEqual([]);
		for (const run of [
			() => measureCandidateScope(files(), { maxStreams: 1 }),
			() => detectCandidateClones(repeatedStreams(2), { maxStreams: 1 }),
		]) {
			expect(run().exhaustion?.kind).toBe("maxStreams");
			expect(run().work.peakCells).toBe(0);
		}
	});

	test("bounds working allocation, total work and adversarial retained output", () => {
		const controls: [DuplicationWorkOptions, DuplicationStop["kind"]][] = [
			[{ maxWorkingCells: 0 }, "maxWorkingCells"],
			[{ maxMatchWork: 0 }, "maxMatchWork"],
			[{ maxGroups: 0 }, "maxGroups"],
			[{ maxOccurrences: 1 }, "maxOccurrences"],
		];
		for (const [options, kind] of controls) {
			const result = measureCandidateScope(files(), options);
			expect(result.exhaustion?.kind).toBe(kind);
			expect(result.groups).toEqual([]);
			expect(result.totals).toBeNull();
		}
		const run = syntheticStream("periodic", new Array(1200).fill(1), 50);
		expect(detectCandidateClones([run], { maxOccurrences: 100 }).exhaustion?.kind).toBe(
			"maxOccurrences",
		);
	});

	test("honors already-cancelled and mid-operation cancellation", () => {
		expect(measureCandidateScope(files(), { isCancelled: () => true }).exhaustion).toEqual({
			phase: "input",
			kind: "cancelled",
			limit: 0,
		});
		const full = measureCandidateScope(files(40));
		let calls = 0;
		const partial = measureCandidateScope(files(40), { isCancelled: () => ++calls > 12 });
		expect(partial.exhaustion?.kind).toBe("cancelled");
		expect(partial.work.total).toBeLessThan(full.work.total);
		expect(partial.groups).toEqual([]);
		expect(partial.totals).toBeNull();
	});

	test("latches the first failure and propagates unrelated operational errors", () => {
		const work = new DuplicationWork({ maxMatchWork: 0 });
		let original: unknown;
		try {
			work.charge();
		} catch (error) {
			original = error;
		}
		for (const operation of [
			() => work.charge(),
			() => work.enter("finalization"),
			() => work.stop("maxGroups", 0),
		]) {
			try {
				operation();
				throw new Error("Expected latched failure");
			} catch (error) {
				expect(error).toBe(original);
			}
		}
		expect(() =>
			measureCandidateScope(files(), {
				isCancelled: () => {
					throw new Error("unexpected failure");
				},
			}),
		).toThrow("unexpected failure");
		expect(() => detectCandidateClones([syntheticStream("bad", [-1])])).toThrow(RangeError);
	});

	test("rejects mixed source sets before claiming a duplication result", () => {
		const a = sourceFile("a", repeatedSource("a"));
		const b = { ...a, path: "b", sourceSet: "test" as const };
		expect(() => measureCandidateScope([a, b])).toThrow("one source set");
		expect(() => detectCandidateClones([collectTokenStream(a), collectTokenStream(b)])).toThrow(
			"one source set",
		);
	});
});
