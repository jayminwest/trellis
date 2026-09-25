import { describe, expect, test } from "bun:test";
import { parseYaml } from "./yaml.ts";

describe("parseYaml", () => {
	test("parses an empty or comment-only document to undefined", () => {
		expect(parseYaml("")).toBeUndefined();
		expect(parseYaml("# only a comment\n")).toBeUndefined();
	});

	test("resolves merge keys like the js-yaml 4 default schema", () => {
		expect(parseYaml("base: &b { a: 1 }\nchild:\n  <<: *b\n  c: 2\n")).toEqual({
			base: { a: 1 },
			child: { a: 1, c: 2 },
		});
	});

	test("rejects multi-document streams and malformed input", () => {
		expect(() => parseYaml("a: 1\n---\nb: 2\n")).toThrow(/single YAML document/);
		expect(() => parseYaml("a: [1\n")).toThrow();
	});
});
