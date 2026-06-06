import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRubric, RubricError } from "./loader.ts";

/** A valid baseline: two categories, each with exactly one gate criterion. */
const VALID = {
	"categories.yaml": `
- id: documentation
  title: Documentation
  description: Documentation scope.
- id: testing
  title: Testing
  description: Testing scope.
`,
	"repo-scope.yaml": `
- id: agents_md
  category: documentation
  scope: repo
  level: 1
  skippable: false
  discoveryVia: deterministic
  gate: true
- id: readme_quality
  category: documentation
  scope: repo
  level: 2
  skippable: false
  discoveryVia: agent
  investigation: documentation
`,
	"app-scope.yaml": `
- id: test_layout
  category: testing
  scope: app
  level: 2
  skippable: false
  discoveryVia: agent
  investigation: test-layout
  gate: true
`,
};

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "trellis-rubric-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Write a rubric fixture (baseline merged with `overrides`) to the temp dir. */
function writeRubric(overrides: Partial<typeof VALID> = {}): void {
	const files = { ...VALID, ...overrides };
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(dir, name), content);
	}
}

describe("loadRubric", () => {
	test("loads a valid rubric with parsed records and defaults", () => {
		writeRubric();
		const rubric = loadRubric(dir);

		expect(rubric.categories.map((c) => c.id)).toEqual(["documentation", "testing"]);
		expect(rubric.criteria.map((c) => c.id)).toEqual([
			"agents_md",
			"readme_quality",
			"test_layout",
		]);

		const agentsMd = rubric.criteria.find((c) => c.id === "agents_md");
		expect(agentsMd?.weight).toBe(1);
		expect(agentsMd?.investigation).toBeNull();
		expect(agentsMd?.gate).toBe(true);
	});

	test("throws RubricError with id and file when a record fails schema", () => {
		writeRubric({
			"repo-scope.yaml": `
- id: bad_weight
  category: documentation
  scope: repo
  level: 1
  skippable: false
  discoveryVia: deterministic
  gate: true
  weight: 0
`,
		});
		try {
			loadRubric(dir);
			throw new Error("expected loadRubric to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(RubricError);
			expect((err as RubricError).id).toBe("bad_weight");
			expect((err as RubricError).file).toBe("repo-scope.yaml");
		}
	});

	test("rejects an agent criterion missing an investigation area", () => {
		writeRubric({
			"app-scope.yaml": `
- id: test_layout
  category: testing
  scope: app
  level: 2
  skippable: false
  discoveryVia: agent
  gate: true
`,
		});
		expect(() => loadRubric(dir)).toThrow(/investigation/);
	});

	test("rejects a criterion whose scope mismatches its source file", () => {
		writeRubric({
			"repo-scope.yaml": `
- id: agents_md
  category: documentation
  scope: app
  level: 1
  skippable: false
  discoveryVia: deterministic
  gate: true
`,
		});
		try {
			loadRubric(dir);
			throw new Error("expected loadRubric to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(RubricError);
			expect((err as RubricError).id).toBe("agents_md");
			expect((err as RubricError).file).toBe("repo-scope.yaml");
			expect((err as RubricError).message).toContain("scope");
		}
	});

	test("rejects a category with no gate:true criterion", () => {
		writeRubric({
			"repo-scope.yaml": `
- id: agents_md
  category: documentation
  scope: repo
  level: 1
  skippable: false
  discoveryVia: deterministic
`,
		});
		try {
			loadRubric(dir);
			throw new Error("expected loadRubric to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(RubricError);
			expect((err as RubricError).id).toBe("documentation");
			expect((err as RubricError).message).toContain("no gate");
		}
	});

	test("rejects a category with more than one gate:true criterion", () => {
		writeRubric({
			"repo-scope.yaml": `
- id: agents_md
  category: documentation
  scope: repo
  level: 1
  skippable: false
  discoveryVia: deterministic
  gate: true
- id: contributing_md
  category: documentation
  scope: repo
  level: 1
  skippable: false
  discoveryVia: deterministic
  gate: true
`,
		});
		try {
			loadRubric(dir);
			throw new Error("expected loadRubric to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(RubricError);
			expect((err as RubricError).id).toBe("documentation");
			expect((err as RubricError).message).toContain("expected exactly one");
		}
	});

	test("rejects a criterion referencing an unknown category", () => {
		writeRubric({
			"repo-scope.yaml": `
- id: agents_md
  category: nonexistent
  scope: repo
  level: 1
  skippable: false
  discoveryVia: deterministic
  gate: true
`,
		});
		try {
			loadRubric(dir);
			throw new Error("expected loadRubric to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(RubricError);
			expect((err as RubricError).id).toBe("agents_md");
			expect((err as RubricError).message).toContain("unknown category");
		}
	});

	test("rejects a duplicate criterion id across scope files", () => {
		writeRubric({
			"app-scope.yaml": `
- id: agents_md
  category: testing
  scope: app
  level: 2
  skippable: false
  discoveryVia: agent
  investigation: test-layout
  gate: true
`,
		});
		try {
			loadRubric(dir);
			throw new Error("expected loadRubric to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(RubricError);
			expect((err as RubricError).id).toBe("agents_md");
			expect((err as RubricError).message).toContain("duplicate criterion id");
		}
	});

	test("rejects a duplicate category id", () => {
		writeRubric({
			"categories.yaml": `
- id: documentation
  title: Documentation
  description: Documentation scope.
- id: documentation
  title: Docs Again
  description: Duplicate.
- id: testing
  title: Testing
  description: Testing scope.
`,
		});
		try {
			loadRubric(dir);
			throw new Error("expected loadRubric to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(RubricError);
			expect((err as RubricError).id).toBe("documentation");
			expect((err as RubricError).message).toContain("duplicate category id");
		}
	});

	test("rejects a non-sequence YAML file", () => {
		writeRubric({ "categories.yaml": "id: not-a-list\n" });
		try {
			loadRubric(dir);
			throw new Error("expected loadRubric to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(RubricError);
			expect((err as RubricError).message).toContain("sequence");
		}
	});

	test("throws RubricError when a source file is missing", () => {
		// only write categories.yaml; scope files absent
		writeFileSync(join(dir, "categories.yaml"), VALID["categories.yaml"]);
		try {
			loadRubric(dir);
			throw new Error("expected loadRubric to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(RubricError);
			expect((err as RubricError).file).toBe("repo-scope.yaml");
		}
	});
});
