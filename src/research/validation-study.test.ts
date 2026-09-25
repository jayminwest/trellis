import { describe, expect, test } from "bun:test";
import judgments from "../../docs/research/validation-study/judgments.json";
import tasks from "../../docs/research/validation-study/tasks.json";
import {
	aIsAfter,
	analyzeStudy,
	blindedPacket,
	type Judgment,
	measureSignals,
} from "./validation-study.ts";

describe("validation study tasks", () => {
	test("cover every category both issues require, and every source parses", () => {
		const categories = new Set(tasks.map((task) => task.category));
		for (const required of [
			"legitimate-facade",
			"callback",
			"transaction-wrapper",
			"dispatch-domains",
			"default-subset",
			"if-chain-vs-table",
			"loop-guard",
			"extraction",
			"independent-rules",
			"declarations-with-callbacks",
			"overlapping-clones",
		]) {
			expect(categories.has(required)).toBe(true);
		}
		for (const task of tasks) {
			expect(() => measureSignals(task.before)).not.toThrow();
			expect(() => measureSignals(task.after)).not.toThrow();
		}
	});

	test("the overlapping-clone task carries a native clone group before, none after", () => {
		const task = tasks.find((candidate) => candidate.id === "overlapping-clone-ranges");
		expect(measureSignals(task?.before ?? "").cloneGroups).toBe(1);
		expect(measureSignals(task?.after ?? "").cloneGroups).toBe(0);
	});
});

describe("blindedPacket", () => {
	test("hides which side is after, deterministically, and never leaks signals", () => {
		const packet = blindedPacket(tasks);
		expect(packet).toEqual(blindedPacket(tasks));
		for (const [index, entry] of packet.entries()) {
			const task = tasks[index];
			if (task === undefined) throw new Error("packet longer than tasks");
			expect(Object.keys(entry).sort()).toEqual(["A", "B", "id", "task"]);
			expect(entry.A).toBe(aIsAfter(entry.id) ? task.after : task.before);
		}
		const flips = packet.filter((entry) => aIsAfter(entry.id)).length;
		expect(flips).toBeGreaterThan(0);
		expect(flips).toBeLessThan(packet.length);
	});
});

describe("analyzeStudy", () => {
	test("draws no conclusion from the committed judgments until reviewers respond", () => {
		const result = analyzeStudy(tasks, judgments as Judgment[]);
		expect(result.status).toBe("awaiting-independent-judgments");
		expect(result.outcomes).toEqual([]);
		expect(result.tasks).toHaveLength(tasks.length);
	});

	test("scores synthetic judgments: agreement, false positives and misses per signal", () => {
		const loop = tasks.find((task) => task.id === "loop-guard");
		const extraction = tasks.find((task) => task.id === "single-use-extraction");
		if (loop === undefined || extraction === undefined) throw new Error("fixture tasks missing");
		const prefer = (taskId: string, side: "after" | "before", reviewer: string): Judgment => ({
			taskId,
			reviewer,
			preferred: (side === "after") === aIsAfter(taskId) ? "A" : "B",
			independent: true,
		});
		const synthetic = [
			prefer(loop.id, "after", "r1"),
			prefer(loop.id, "after", "r2"),
			prefer(extraction.id, "before", "r1"),
			prefer(extraction.id, "before", "r2"),
			// Non-independent and single-reviewer judgments never decide a task.
			{ ...prefer("if-chain-to-table", "after", "author"), independent: false },
			prefer("callback-adapter", "after", "r1"),
		];
		const result = analyzeStudy([loop, extraction], synthetic);
		expect(result.status).toBe("judged");
		expect(result.decidedTasks).toBe(2);
		const flow = result.outcomes.find((outcome) => outcome.signal === "maxFlow");
		expect(flow?.agrees).toBeGreaterThanOrEqual(1);
		const functions = result.outcomes.find((outcome) => outcome.signal === "functions");
		expect(functions?.agrees).toBe(1); // extraction added functions; reviewers preferred before
		expect(functions?.misses).toEqual(["loop-guard"]);
	});
});
