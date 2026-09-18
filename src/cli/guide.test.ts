import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guide } from "../client/index.ts";
import { GUIDE_NAMES, GuideError, getGuide } from "../guides/index.ts";

describe("guide", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "trellis-guide-"));
	});
	afterEach(() => rmSync(cwd, { recursive: true, force: true }));

	async function invoke(args: string[]) {
		const child = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts"), ...args], {
			cwd,
			env: {
				PATH: "",
				HOME: cwd,
				TRELLIS_DB: join(cwd, "unused.db"),
				// Exclude Bun's own transpiler cache from the Trellis no-write assertion.
				BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { stdout, stderr, code };
	}

	test("shares canonical content across core, SDK and CLI without workspace writes", async () => {
		const expected = getGuide("cleanup");
		expect(guide("cleanup")).toEqual(expected);
		for (const flag of [[], ["--md"], ["--json"]]) {
			const result = await invoke(["guide", "cleanup", ...flag]);
			expect(result.code).toBe(0);
			expect(result.stderr).toBe("");
			if (flag.includes("--json")) expect(JSON.parse(result.stdout)).toEqual(expected);
			else expect(result.stdout).toBe(expected.content);
		}
		expect(readdirSync(cwd)).toEqual([]);
	}, 20_000);

	test("ignores target configuration and executable project scripts", async () => {
		writeFileSync(join(cwd, "trellis.yaml"), "invalid: [");
		writeFileSync(join(cwd, "package.json"), '{"scripts":{"test":"touch executed"}}');
		const before = readdirSync(cwd);
		expect((await invoke(["guide", "cleanup"])).code).toBe(0);
		expect(readdirSync(cwd)).toEqual(before);
	}, 20_000);

	test("advertises cleanup in normal help and guide help", async () => {
		for (const args of [["--help"], ["guide", "--help"]]) {
			const result = await invoke(args);
			expect(result.code).toBe(0);
			expect(result.stdout).toContain("cleanup");
		}
	}, 20_000);

	test("rejects unknown guides consistently and lists supported names", async () => {
		expect(GUIDE_NAMES).toEqual(["cleanup"]);
		expect(() => getGuide("unknown")).toThrow(GuideError);
		expect(() => guide("unknown")).toThrow("Supported guides: cleanup");
		for (const flag of [[], ["--json"]]) {
			const result = await invoke(["guide", "unknown", ...flag]);
			expect(result.code).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("Unknown guide");
			expect(result.stderr).toContain("Supported guides: cleanup");
		}
	}, 20_000);

	test("rejects missing guide names and conflicting output flags", async () => {
		for (const args of [["guide"], ["guide", "cleanup", "--json", "--md"]]) {
			const result = await invoke(args);
			expect(result.code).toBe(1);
			expect(result.stdout).toBe("");
		}
	}, 20_000);
});
