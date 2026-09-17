import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { discoverSourceInventory } from "../discovery/index.ts";
import { buildSyntaxInventory } from "./inventory.ts";

let repo: string;

beforeEach(async () => {
	repo = await mkdtemp(join(tmpdir(), "trellis-syntax-"));
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

/** Discover + build over the current temp repo. */
async function build() {
	return buildSyntaxInventory(await discoverSourceInventory(repo));
}

describe("buildSyntaxInventory", () => {
	test("carries discovery ownership and parses every classified file once", async () => {
		await put("package.json", JSON.stringify({ name: "app" }));
		await put("src/math.ts", "export function add(a: number, b: number) {\n\treturn a + b;\n}\n");
		await put("src/view.tsx", "export const V = () => <div>hi</div>;\n");
		await put("src/math.test.ts", "test('add', () => {});\n");

		const inventory = await build();
		expect(inventory.compilerVersion).toBe(ts.version);
		expect(inventory.completeness).toBe("complete");
		expect(inventory.diagnostics).toEqual([]);
		expect(inventory.files.map((file) => [file.path, file.sourceSet, file.scriptKind])).toEqual([
			["src/math.test.ts", "test", "ts"],
			["src/math.ts", "production", "ts"],
			["src/view.tsx", "production", "tsx"],
		]);
		for (const file of inventory.files) expect(file.packagePath).toBe(".");
		expect(inventory.functionCount).toBe(3);
	});

	test("shares one parse across every derived fact — the reuse contract", async () => {
		await put("src/shared.ts", "export function f() {\n\treturn () => 1;\n}\n");
		const inventory = await build();
		const file = inventory.files[0];
		expect(file?.functions).toHaveLength(2);
		// Every function fact points into the file's single SourceFile: an
		// analyzer consuming `functions` and one consuming `sourceFile` walk
		// the same tree — no re-parse anywhere in the audit.
		if (file) {
			for (const fn of file.functions) {
				expect(fn.node.getSourceFile()).toBe(file.sourceFile);
			}
		}
		expect(file?.sourceFile.fileName).toBe("src/shared.ts");
	});

	test("maps function positions to the real lines of the file", async () => {
		await put(
			"src/located.ts",
			"// header\nexport function measured(a: number) {\n\tif (a > 0) return a;\n\treturn 0;\n}\n",
		);
		const inventory = await build();
		const fn = inventory.files[0]?.functions[0];
		expect(fn?.name).toBe("measured");
		expect(fn?.range).toEqual({
			start: { line: 2, column: 1 },
			end: { line: 5, column: 2 },
		});
		expect(inventory.files[0]?.lines.code).toBe(4);
	});

	test("marks the audit incomplete with located diagnostics when a file fails to parse", async () => {
		await put("src/ok.ts", "export const ok = 1;\n");
		await put("src/broken.ts", "const x = ;\n");
		const inventory = await build();
		expect(inventory.completeness).toBe("incomplete");
		expect(inventory.diagnostics).toHaveLength(1);
		expect(inventory.diagnostics[0]?.path).toBe("src/broken.ts");
		expect(inventory.diagnostics[0]?.code).toBe("TS1109");
		expect(inventory.diagnostics[0]?.range.start.line).toBe(1);
		// The broken file still contributes a (partial) analysis.
		expect(inventory.files.map((file) => file.path)).toContain("src/broken.ts");
	});

	test("surfaces a read failure as a read-error diagnostic, never a throw", async () => {
		await put("src/vanishing.ts", "export const v = 1;\n");
		const discovered = await discoverSourceInventory(repo);
		await rm(join(repo, "src/vanishing.ts"));
		const inventory = await buildSyntaxInventory(discovered);
		expect(inventory.completeness).toBe("incomplete");
		expect(inventory.diagnostics[0]?.code).toBe("read-error");
		expect(inventory.files[0]?.functions).toEqual([]);
		expect(inventory.files[0]?.lines).toEqual({ total: 1, code: 0, commentOnly: 0, blank: 1 });
	});

	test("gives declaration-only files a finite empty inventory", async () => {
		await put("types/ambient.d.ts", "declare function ambient(x: number): void;\n");
		const inventory = await build();
		const file = inventory.files[0];
		expect(file?.sourceSet).toBe("declaration-only");
		expect(file?.functions).toEqual([]);
		expect(file?.signatureCount).toBe(1);
		expect(file?.lines.code).toBe(1);
		expect(inventory.completeness).toBe("complete");
	});

	test("is deterministic — two builds over the same tree agree on every fact", async () => {
		await put("src/b.ts", "export const b = () => 2;\n");
		await put("src/a.ts", "export function a() {\n\treturn b() + 1;\n}\n");
		const project = (inventory: Awaited<ReturnType<typeof build>>) =>
			inventory.files.map((file) => ({
				path: file.path,
				lines: file.lines,
				signatures: file.signatureCount,
				functions: file.functions.map((fn) => ({
					kind: fn.kind,
					name: fn.name,
					depth: fn.depth,
					parentIndex: fn.parentIndex,
					range: fn.range,
					bodyRange: fn.bodyRange,
				})),
			}));
		const [first, second] = [await build(), await build()];
		expect(project(first)).toEqual(project(second));
		expect(first.completeness).toBe(second.completeness);
	});
});
