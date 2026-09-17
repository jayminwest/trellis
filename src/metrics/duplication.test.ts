import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSourceInventory } from "../discovery/index.ts";
import { buildSyntaxInventory } from "../syntax/index.ts";
import { analyzeDuplication, type CloneGroup } from "./index.ts";

let repo: string;

beforeEach(async () => {
	repo = await mkdtemp(join(tmpdir(), "trellis-duplication-"));
});

afterEach(async () => {
	await rm(repo, { recursive: true, force: true });
});

/** Write `content` to `relPath` under the temp repo, creating parent dirs. */
async function put(relPath: string, content: string): Promise<void> {
	const abs = join(repo, relPath);
	await mkdir(join(abs, ".."), { recursive: true });
	await writeFile(abs, content);
}

/** Discover, parse, and analyze duplication for the current temp repo. */
async function analyze() {
	return analyzeDuplication(await buildSyntaxInventory(await discoverSourceInventory(repo)));
}

/** Compact `path:start-end` member descriptors of a group, for assertions. */
function memberSpans(group: CloneGroup): string[] {
	return group.members.map(
		(member) => `${member.path}:${member.range.start.line}-${member.range.end.line}`,
	);
}

/**
 * 105 normalized tokens over 13 lines — above the 100-token + 3-line
 * minimum (SPEC §5.3) — with cyclomatic complexity 10, below the erosion
 * threshold, so clone fixtures never leak hotspot findings.
 */
const CLONE_FN =
	"export function alpha(a: number, b: number) {\n" + // 1
	"\tconst s = a + b;\n" + // 2
	"\tif (a > 0) return 1;\n" + // 3
	"\tif (a > 1) return 2;\n" + // 4
	"\tif (a > 2) return 3;\n" + // 5
	"\tif (a > 3) return 4;\n" + // 6
	"\tif (a > 4) return 5;\n" + // 7
	"\tif (a > 5) return 6;\n" + // 8
	"\tif (a > 6) return 7;\n" + // 9
	"\tif (a > 7) return 8;\n" + // 10
	"\tif (a > 8) return 9;\n" + // 11
	"\treturn s;\n" + // 12
	"}\n"; // 13

/** The same structure with every identifier and literal renamed (type-2 clone). */
const RENAMED_FN =
	"export function beta(x: number, y: number) {\n" +
	"\tconst total = x + y;\n" +
	"\tif (x > 10) return 7;\n" +
	"\tif (x > 20) return 8;\n" +
	"\tif (x > 30) return 9;\n" +
	"\tif (x > 40) return 10;\n" +
	"\tif (x > 50) return 11;\n" +
	"\tif (x > 60) return 12;\n" +
	"\tif (x > 70) return 13;\n" +
	"\tif (x > 80) return 14;\n" +
	"\tif (x > 90) return 15;\n" +
	"\treturn total;\n" +
	"}\n";

/** A ~30-token shared idiom — below the 100-token minimum. */
const SHORT_IDIOM =
	'const ok = value != null && typeof value === "string" && value.length > 0 && value.length < 100;\n';

describe("analyzeDuplication detection semantics", () => {
	test("exact clone in two files forms one group with both members", async () => {
		await put("src/a.ts", CLONE_FN);
		await put("src/b.ts", CLONE_FN);
		const { scopes } = await analyze();
		expect(scopes.production.groups).toHaveLength(1);
		const group = scopes.production.groups[0];
		expect(group?.id).toBe("clone-group-1");
		expect(memberSpans(group as CloneGroup)).toEqual(["src/a.ts:1-13", "src/b.ts:1-13"]);
		expect(scopes.production.duplicatedLines).toBe(26);
		expect(scopes.production.codeLines).toBe(26);
		expect(scopes.production.density).toBe(1);
	});

	test("identifier/literal-renamed clone is detected at density 1", async () => {
		await put("src/a.ts", CLONE_FN);
		await put("src/b.ts", RENAMED_FN);
		const { scopes } = await analyze();
		expect(scopes.production.groups).toHaveLength(1);
		expect(memberSpans(scopes.production.groups[0] as CloneGroup)).toEqual([
			"src/a.ts:1-13",
			"src/b.ts:1-13",
		]);
		expect(scopes.production.density).toBe(1);
	});

	test("the same function in four files forms one group with four members", async () => {
		for (const name of ["a", "b", "c", "d"]) await put(`src/${name}.ts`, CLONE_FN);
		const { scopes } = await analyze();
		expect(scopes.production.groups).toHaveLength(1);
		expect(scopes.production.groups[0]?.members).toHaveLength(4);
		expect(scopes.production.duplicatedLines).toBe(52);
	});

	test("a below-threshold shared idiom forms no group", async () => {
		await put("src/a.ts", SHORT_IDIOM);
		await put("src/b.ts", SHORT_IDIOM);
		const { scopes } = await analyze();
		expect(scopes.production.groups).toHaveLength(0);
		expect(scopes.production.duplicatedLines).toBe(0);
		expect(scopes.production.density).toBe(0);
	});

	test("a within-file repeat counts as a clone", async () => {
		await put("src/a.ts", CLONE_FN + CLONE_FN);
		const { scopes } = await analyze();
		expect(scopes.production.groups).toHaveLength(1);
		expect(memberSpans(scopes.production.groups[0] as CloneGroup)).toEqual([
			"src/a.ts:1-13",
			"src/a.ts:14-26",
		]);
	});

	test("a near clone reports only the maximal shared run (type-3 out of scope)", async () => {
		const shared =
			"export function near(a: number, b: number) {\n" + // 1
			"\tconst s = a + b;\n" + // 2
			"\tif (a > 0) return 1;\n" + // 3
			"\tif (a > 1) return 2;\n" + // 4
			"\tif (a > 2) return 3;\n" + // 5
			"\tif (a > 3) return 4;\n" + // 6
			"\tif (a > 4) return 5;\n" + // 7
			"\tif (a > 5) return 6;\n" + // 8
			"\tif (a > 6) return 7;\n" + // 9
			"\tif (a > 7) return 8;\n" + // 10
			"\tif (a > 8) return 9;\n"; // 11
		await put("src/a.ts", `${shared}\treturn s * 2;\n}\n`);
		await put("src/b.ts", `${shared}\treturn s;\n}\n`);
		const { scopes } = await analyze();
		expect(scopes.production.groups).toHaveLength(1);
		// The shared `return s` tokens on line 12 extend the maximal run onto a
		// partial boundary line — the documented overhang semantics (SPEC §5.3).
		expect(memberSpans(scopes.production.groups[0] as CloneGroup)).toEqual([
			"src/a.ts:1-12",
			"src/b.ts:1-12",
		]);
	});

	test("a 100-token clone compressed onto two lines is dropped by the 3-line minimum", async () => {
		const wide =
			"const config = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10, k: 11, l: 12, m: 13, n: 14, o: 15, p: 16, q: 17, r: 18, s: 19, t: 20, u: 21, v: 22, w: 23, x: 24, y: 25, z: 26 };\n" +
			"export const ready = config.a + config.z;\n";
		await put("src/a.ts", wide);
		await put("src/b.ts", wide);
		const { scopes } = await analyze();
		expect(scopes.production.groups).toHaveLength(0);
	});

	test("template-literal, regex, and bigint content normalizes to one placeholder", async () => {
		const first =
			"export function render(name: string, count: bigint) {\n" +
			"\tconst pattern = /alpha+/g;\n" +
			"\tconst text = `hello ${" +
			"name} x${" +
			"count}`;\n" +
			"\tif (pattern.test(text) && count > 0n) return text.length;\n" +
			"\tif (count > 1n) return text.length + 1;\n" +
			"\tif (count > 2n) return text.length + 2;\n" +
			"\tif (count > 3n) return text.length + 3;\n" +
			"\tif (count > 4n) return text.length + 4;\n" +
			"\treturn 0;\n" +
			"}\n";
		const second = first
			.replaceAll("alpha+", "beta-")
			.replaceAll("hello", "goodbye")
			.replaceAll("0n", "9n");
		await put("src/a.ts", first);
		await put("src/b.ts", second);
		const { scopes } = await analyze();
		expect(scopes.production.groups).toHaveLength(1);
		expect(scopes.production.density).toBe(1);
	});
});

describe("analyzeDuplication overlap and subsumption", () => {
	// Structurally distinct regions: X (~55 tokens), Y (~60 tokens), Z (~47 tokens).
	const regionX =
		"const xa = 1 + 2;\n" +
		"const xb = xa * 3;\n" +
		"const xc = xb - xa;\n" +
		"const xd = xc / 2;\n" +
		"const xe = xd + xa;\n" +
		"const xf = xe * xa;\n" +
		"const xg = xf - xd;\n";
	const regionY =
		"function pick(flag: boolean): number {\n" +
		"\tif (flag) return 1;\n" +
		"\tif (!flag) return 0;\n" +
		"\tconst step = flag ? 1 : 0;\n" +
		"\tconst next = step + 1;\n" +
		"\tconst last = next - 1;\n" +
		"\treturn last;\n" +
		"}\n";
	const regionZ =
		"const list = [1, 2, 3];\n" +
		"const doubled = list.map((n) => n * 2);\n" +
		"const first = doubled.at(0);\n" +
		"const total = first + doubled.length;\n" +
		'const label = "total:" + total;\n';

	test("overlapping clones form two groups and count shared lines once", async () => {
		await put("src/a.ts", regionX + regionY); // 15 lines: X+Y
		await put("src/b.ts", regionY + regionZ); // 13 lines: Y+Z
		await put("src/c.ts", regionX + regionY + regionZ); // 20 lines: X+Y+Z
		const { scopes } = await analyze();
		const groups = scopes.production.groups;
		expect(groups).toHaveLength(2);
		expect(memberSpans(groups[0] as CloneGroup)).toEqual(["src/a.ts:1-15", "src/c.ts:1-15"]);
		expect(memberSpans(groups[1] as CloneGroup)).toEqual(["src/b.ts:1-13", "src/c.ts:8-20"]);
		// c's lines are counted once in the union: 15 + 13 + 20 = 48, not more.
		expect(scopes.production.duplicatedLines).toBe(48);
		expect(scopes.production.codeLines).toBe(48);
		expect(scopes.production.density).toBe(1);
	});
});

describe("analyzeDuplication grouping edge cases", () => {
	test("two same-length groups with different content stay separate groups", async () => {
		// Same token count, different operator content: both matches land in
		// the same length bucket and content verification keeps them apart.
		await put("src/a.ts", CLONE_FN);
		await put("src/b.ts", CLONE_FN);
		await put("src/c.ts", CLONE_FN.replace("a + b", "a - b").replace("alpha", "beta"));
		await put("src/d.ts", CLONE_FN.replace("a + b", "a - b").replace("alpha", "beta"));
		const { scopes } = await analyze();
		const groups = scopes.production.groups;
		expect(groups).toHaveLength(2);
		expect(memberSpans(groups[0] as CloneGroup)).toEqual(["src/a.ts:1-13", "src/b.ts:1-13"]);
		expect(memberSpans(groups[1] as CloneGroup)).toEqual(["src/c.ts:1-13", "src/d.ts:1-13"]);
	});

	test("a prefix clone beside a fuller clone survives subsumption", async () => {
		// a/c hold X+Y, b holds X alone: the X-only group is not subsumed
		// (b's member is in no larger clone), and the two groups share a
		// first-member path and start line — sorted by end line.
		const regionY =
			"const list = [1, 2, 3];\n" +
			"const doubled = list.map((n) => n * 2);\n" +
			"const first = doubled.at(0);\n";
		await put("src/a.ts", CLONE_FN + regionY);
		await put("src/b.ts", CLONE_FN);
		await put("src/c.ts", CLONE_FN + regionY);
		const { scopes } = await analyze();
		const groups = scopes.production.groups;
		expect(groups).toHaveLength(2);
		expect(memberSpans(groups[0] as CloneGroup)).toEqual([
			"src/a.ts:1-13",
			"src/b.ts:1-13",
			"src/c.ts:1-13",
		]);
		expect(memberSpans(groups[1] as CloneGroup)).toEqual(["src/a.ts:1-16", "src/c.ts:1-16"]);
		// Union per file: a 16, b 13, c 16.
		expect(scopes.production.duplicatedLines).toBe(45);
	});
});

describe("analyzeDuplication scope discipline", () => {
	test("test-to-production matches are never detected (sets are measured separately)", async () => {
		await put("src/a.ts", CLONE_FN);
		await put("src/a.test.ts", CLONE_FN);
		const { scopes } = await analyze();
		expect(scopes.production.groups).toHaveLength(0);
		expect(scopes.test.groups).toHaveLength(0);
		expect(scopes.production.duplicatedLines).toBe(0);
		expect(scopes.test.duplicatedLines).toBe(0);
	});

	test("generated, vendored, declaration-only, and excluded files are never tokenized", async () => {
		await put("src/a.ts", CLONE_FN);
		await put("src/generated/b.ts", CLONE_FN);
		await put("vendor/c.ts", CLONE_FN);
		await put("src/types.d.ts", CLONE_FN);
		await put("dist/d.ts", CLONE_FN);
		const { scopes } = await analyze();
		expect(scopes.production.groups).toHaveLength(0);
		expect(scopes.production.duplicatedLines).toBe(0);
		expect(scopes.production.files).toBe(1);
	});

	test("a clone pair inside the test set is measured in the test scope only", async () => {
		await put("src/a.test.ts", CLONE_FN);
		await put("tests/b.ts", CLONE_FN);
		const { scopes } = await analyze();
		expect(scopes.test.groups).toHaveLength(1);
		expect(scopes.test.density).toBe(1);
		expect(scopes.production.groups).toHaveLength(0);
	});
});
