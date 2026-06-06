import { describe, expect, test } from "bun:test";
import { ALL_AREAS, AREA_IDS, AREAS, areaById } from "./areas.ts";

describe("AREAS", () => {
	test("defines exactly the four fixed areas", () => {
		expect(AREA_IDS).toEqual(["documentation", "agent-config", "setup-runnability", "test-layout"]);
		expect(Object.keys(AREAS).sort()).toEqual([...AREA_IDS].sort());
		expect(ALL_AREAS).toHaveLength(4);
	});

	test("each area's id is self-consistent and key-consistent", () => {
		for (const id of AREA_IDS) {
			expect(AREAS[id].id).toBe(id);
			expect(areaById(id)).toBe(AREAS[id]);
		}
	});

	test("every area carries a title, description, facts, and a prompt", () => {
		for (const area of ALL_AREAS) {
			expect(area.title.length).toBeGreaterThan(0);
			expect(area.description.length).toBeGreaterThan(0);
			expect(area.facts.length).toBeGreaterThan(0);
			expect(area.prompt.length).toBeGreaterThan(0);
		}
	});

	test("each prompt is read-only, facts-not-verdicts, submit_findings exactly once", () => {
		for (const area of ALL_AREAS) {
			expect(area.prompt).toContain("read-only");
			expect(area.prompt.toLowerCase()).toContain("facts");
			expect(area.prompt).toContain("submit_findings");
			expect(area.prompt).toContain("EXACTLY ONCE");
			// every gathered fact is rendered into the prompt
			for (const fact of area.facts) expect(area.prompt).toContain(fact);
		}
	});

	test("prompt rendering is deterministic (pure function of the area)", () => {
		for (const id of AREA_IDS) expect(AREAS[id].prompt).toBe(AREAS[id].prompt);
	});
});
