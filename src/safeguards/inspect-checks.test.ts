import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SafeguardResult } from "../contract/index.ts";
import { inspectSafeguards } from "./inspect.ts";

let repo: string;

beforeEach(async () => {
	repo = await mkdtemp(join(tmpdir(), "trellis-safeguards-inspect-"));
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

/** Minimal manifest helper: scripts map + extras. */
function manifest(scripts: Record<string, string>, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ name: "demo", ...extra, scripts }, null, "\t");
}

/** A CI workflow with the given run steps (single scalar lines). */
function workflow(steps: readonly string[], uses: readonly string[] = []): string {
	const lines = [
		"name: CI",
		"on: push",
		"jobs:",
		"  ci:",
		"    runs-on: ubuntu-latest",
		"    steps:",
	];
	for (const use of uses) lines.push(`      - uses: ${use}`);
	for (const step of steps) lines.push(`      - run: ${step}`);
	return lines.join("\n");
}

/** Index results by id for direct lookups. */
function byId(results: readonly SafeguardResult[]): Map<string, SafeguardResult> {
	return new Map(results.map((result) => [result.id, result]));
}

describe("lint/typecheck/test scripts", () => {
	test("dependency presence alone is not evidence", async () => {
		await put(
			"package.json",
			JSON.stringify({
				name: "demo",
				devDependencies: { eslint: "9.0.0", vitest: "3.0.0", typescript: "5.0.0" },
				scripts: { build: "tsc -b" },
			}),
		);
		const results = byId((await inspectSafeguards(repo)).results);
		expect(results.get("lint-script")?.evidence).toBe("absent");
		expect(results.get("typecheck-script")?.evidence).toBe("absent");
		expect(results.get("test-script")?.evidence).toBe("absent");
	});

	test("custom-named scripts are recognized through their command bodies", async () => {
		await put(
			"package.json",
			manifest({ "check:lint": "biome check .", "quality:types": "tsc --noEmit" }),
		);
		const results = byId((await inspectSafeguards(repo)).results);
		expect(results.get("lint-script")?.evidence).toBe("configured");
		expect(results.get("typecheck-script")?.evidence).toBe("configured");
	});

	test("a CI run step invoking the script wires it", async () => {
		await put("package.json", manifest({ "check:lint": "biome check ." }));
		await put(".github/workflows/ci.yml", workflow(["bun run check:lint"]));
		const result = byId((await inspectSafeguards(repo)).results).get("lint-script");
		expect(result?.evidence).toBe("structurally-wired");
		expect(result?.notes).toContain(".github/workflows/ci.yml");
	});

	test("transitive script chains wire the check", async () => {
		await put(
			"package.json",
			manifest({
				verify: "bun run check:lint && bun run test",
				"check:lint": "biome check .",
				test: "bun test",
			}),
		);
		await put(".github/workflows/ci.yml", workflow(["bun run verify"]));
		const results = byId((await inspectSafeguards(repo)).results);
		expect(results.get("lint-script")?.evidence).toBe("structurally-wired");
		expect(results.get("test-script")?.evidence).toBe("structurally-wired");
	});

	test("CI invoking the check command directly wires the script", async () => {
		await put("package.json", manifest({ test: "bun test" }));
		await put(".github/workflows/ci.yml", workflow(["bun test --coverage"]));
		const result = byId((await inspectSafeguards(repo)).results).get("test-script");
		expect(result?.evidence).toBe("structurally-wired");
	});

	test("a check reachable only through an executable runner stays configured", async () => {
		await put(
			"package.json",
			manifest({ "check:all": "bun scripts/check-all.ts", lint: "biome check ." }),
		);
		await put("scripts/check-all.ts", "export {};\n");
		await put(".github/workflows/ci.yml", workflow(["bun run check:all"]));
		const result = byId((await inspectSafeguards(repo)).results).get("lint-script");
		expect(result?.evidence).toBe("configured");
		expect(result?.notes).toContain("executable runner");
	});

	test("an unparseable manifest makes every script safeguard unknown", async () => {
		await put("package.json", "{ broken");
		const results = byId((await inspectSafeguards(repo)).results);
		for (const id of ["lint-script", "typecheck-script", "test-script"]) {
			expect(results.get(id)?.evidence).toBe("unknown");
		}
	});

	test("a script referencing a missing check file is a located broken reference", async () => {
		await put(
			"package.json",
			manifest({ "check:coverage": "bun run scripts/check-coverage.ts", test: "bun test" }),
		);
		const inspection = await inspectSafeguards(repo);
		const finding = inspection.findings.find((f) => f.summary.includes("check-coverage.ts"));
		expect(finding?.kind).toBe("safeguard.broken-reference");
		expect(finding?.path).toBe("package.json");
		expect(finding?.range.start.line).toBeGreaterThan(1);
	});
});

describe("budgets", () => {
	test("a coverage budget file alone is configured", async () => {
		await put("package.json", manifest({}));
		await put("scripts/coverage-budgets.json", '{"functions": 96}\n');
		const result = byId((await inspectSafeguards(repo)).results).get("coverage-budget");
		expect(result?.evidence).toBe("configured");
	});

	test("a budget referenced by a CI-reachable check is structurally-wired", async () => {
		await put(
			"package.json",
			manifest({
				"check:size": "bun scripts/check-file-sizes.ts --budget scripts/file-size-budgets.json",
			}),
		);
		await put("scripts/file-size-budgets.json", '{"threshold": 400}\n');
		await put("scripts/check-file-sizes.ts", "export {};\n");
		await put(".github/workflows/ci.yml", workflow(["bun run check:size"]));
		const result = byId((await inspectSafeguards(repo)).results).get("file-size-budget");
		expect(result?.evidence).toBe("structurally-wired");
	});

	test("a budget referenced by a transitively reachable check is structurally-wired", async () => {
		await put(
			"package.json",
			manifest({
				verify: "bun run check:size",
				"check:size": "bun scripts/check-file-sizes.ts --budget scripts/file-size-budgets.json",
			}),
		);
		await put("scripts/file-size-budgets.json", '{"threshold": 400}\n');
		await put("scripts/check-file-sizes.ts", "export {};\n");
		await put(".github/workflows/ci.yml", workflow(["bun run verify"]));
		const result = byId((await inspectSafeguards(repo)).results).get("file-size-budget");
		expect(result?.evidence).toBe("structurally-wired");
	});

	test("the l5-toolkit layout is wired one hop through the check script file (trellis-b412)", async () => {
		await put(
			"package.json",
			manifest({
				"check:size": "bun run scripts/check-file-sizes.ts",
				"check:coverage:ci": "bun run scripts/check-coverage.ts --junit",
			}),
		);
		await put("scripts/file-size-budgets.json", '{"threshold": 400}\n');
		await put("scripts/coverage-budgets.json", '{"functions": 96}\n');
		await put(
			"scripts/check-file-sizes.ts",
			'const BUDGETS_PATH = resolve(REPO_ROOT, "scripts/file-size-budgets.json");\n',
		);
		await put(
			"scripts/check-coverage.ts",
			'const BUDGETS_PATH = join(import.meta.dir, "coverage-budgets.json");\n',
		);
		await put(
			".github/workflows/ci.yml",
			workflow(["bun run check:size", "bun run check:coverage:ci"]),
		);
		const results = byId((await inspectSafeguards(repo)).results);
		for (const id of ["file-size-budget", "coverage-budget"]) {
			expect(results.get(id)?.evidence).toBe("structurally-wired");
		}
		expect(results.get("file-size-budget")?.notes).toContain(
			"script 'check:size' (reachable from .github/workflows/ci.yml) runs scripts/check-file-sizes.ts, which names scripts/file-size-budgets.json",
		);
	});

	test("a budget no CI-reachable command or script file names stays configured", async () => {
		await put("package.json", manifest({ "check:size": "bun run scripts/check-file-sizes.ts" }));
		await put("scripts/file-size-budgets.json", '{"threshold": 400}\n');
		await put("scripts/check-file-sizes.ts", "const limit = 400;\n");
		await put(".github/workflows/ci.yml", workflow(["bun run check:size"]));
		const result = byId((await inspectSafeguards(repo)).results).get("file-size-budget");
		expect(result?.evidence).toBe("configured");
	});

	test("a script file naming the budget that CI never reaches stays configured", async () => {
		await put("package.json", manifest({ "check:size": "bun run scripts/check-file-sizes.ts" }));
		await put("scripts/file-size-budgets.json", '{"threshold": 400}\n');
		await put("scripts/check-file-sizes.ts", 'const p = "scripts/file-size-budgets.json";\n');
		await put(".github/workflows/ci.yml", workflow(["bun test"]));
		const result = byId((await inspectSafeguards(repo)).results).get("file-size-budget");
		expect(result?.evidence).toBe("configured");
	});

	test("an unparseable budget file is unknown", async () => {
		await put("package.json", manifest({}));
		await put("scripts/coverage-budgets.json", "{ nope");
		const result = byId((await inspectSafeguards(repo)).results).get("coverage-budget");
		expect(result?.evidence).toBe("unknown");
	});

	test("coverage thresholds in an executable test config are unknown", async () => {
		await put("package.json", manifest({ test: "vitest run" }));
		await put("vitest.config.ts", "export default {};\n");
		const result = byId((await inspectSafeguards(repo)).results).get("coverage-budget");
		expect(result?.evidence).toBe("unknown");
		expect(result?.notes).toContain("unverified");
	});

	test("a duplication budget is wired through the jscpd check convention", async () => {
		await put("package.json", manifest({ "check:dups": "bunx jscpd" }));
		await put(".jscpd.json", '{"threshold": 2}\n');
		await put(".github/workflows/ci.yml", workflow(["bun run check:dups"]));
		const result = byId((await inspectSafeguards(repo)).results).get("duplication-budget");
		expect(result?.evidence).toBe("structurally-wired");
	});

	test("a declarative jscpd manifest key is a configured budget surface", async () => {
		await put("package.json", manifest({}, { jscpd: { threshold: 2 } }));
		const result = byId((await inspectSafeguards(repo)).results).get("duplication-budget");
		expect(result?.evidence).toBe("configured");
	});
});
