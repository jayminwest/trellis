import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findingSchema, type SafeguardResult, safeguardResultSchema } from "../contract/index.ts";
import { inspectSafeguards, SAFEGUARD_IDS } from "./inspect.ts";

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

describe("inspectSafeguards panel shape", () => {
	test("an empty repo reports every safeguard absent with no findings", async () => {
		const inspection = await inspectSafeguards(repo);
		expect(inspection.results.map((r) => r.id)).toEqual([...SAFEGUARD_IDS]);
		for (const result of inspection.results) {
			expect(result.evidence).toBe("absent");
			expect(result.locations).toEqual([]);
		}
		expect(inspection.findings).toEqual([]);
	});

	test("every result and finding validates against the §6 contracts", async () => {
		await put("package.json", manifest({ lint: "biome check ." }));
		await put(".github/workflows/ci.yml", workflow(["bun run lint"]));
		await put(".husky/pre-commit", "#!/bin/sh\nbun run lint\n");
		const inspection = await inspectSafeguards(repo);
		for (const result of inspection.results) {
			expect(() => safeguardResultSchema.parse(result)).not.toThrow();
		}
		for (const finding of inspection.findings) {
			expect(() => findingSchema.parse(finding)).not.toThrow();
		}
	});

	test("inspection is deterministic across runs", async () => {
		await put("package.json", manifest({ test: "bun test", lint: "biome check ." }));
		await put(".github/workflows/ci.yml", workflow(["bun run lint", "bun test"]));
		const first = await inspectSafeguards(repo);
		const second = await inspectSafeguards(repo);
		expect(second).toEqual(first);
	});

	test("agent instructions and os-eco state dirs grant no safeguard evidence", async () => {
		await put("AGENTS.md", "# agent instructions\n");
		await put("CLAUDE.md", "# claude\n");
		await put(".seeds/issues.jsonl", "{}\n");
		await put(".mulch/expertise/domain.jsonl", "{}\n");
		const inspection = await inspectSafeguards(repo);
		for (const result of inspection.results) expect(result.evidence).toBe("absent");
		expect(inspection.findings).toEqual([]);
	});
});

describe("pre-commit-hook", () => {
	test("core.hooksPath wiring with a committed hook is structurally-wired", async () => {
		await put("package.json", manifest({ prepare: "git config core.hooksPath scripts/hooks" }));
		await put("scripts/hooks/pre-commit", "#!/bin/sh\n");
		const inspection = await inspectSafeguards(repo);
		const result = byId(inspection.results).get("pre-commit-hook");
		expect(result?.evidence).toBe("structurally-wired");
		expect(result?.locations.map((l) => l.path)).toEqual([
			"package.json",
			"scripts/hooks/pre-commit",
		]);
		// the hooksPath *directory* reference is a valid target — no broken reference
		expect(inspection.findings).toEqual([]);
	});

	test("core.hooksPath wiring without the hook file is a located broken reference", async () => {
		await put("package.json", manifest({ prepare: "git config core.hooksPath scripts/hooks" }));
		const inspection = await inspectSafeguards(repo);
		const result = byId(inspection.results).get("pre-commit-hook");
		expect(result?.evidence).toBe("configured");
		const finding = inspection.findings.find((f) => f.summary.includes("pre-commit"));
		expect(finding?.kind).toBe("safeguard.broken-reference");
		expect(finding?.path).toBe("package.json");
		expect(finding?.range.start.line).toBeGreaterThan(1);
	});

	test("husky hook with a prepare install script is structurally-wired", async () => {
		await put("package.json", manifest({ prepare: "husky" }));
		await put(".husky/pre-commit", "bun run lint\n");
		const result = byId((await inspectSafeguards(repo)).results).get("pre-commit-hook");
		expect(result?.evidence).toBe("structurally-wired");
	});

	test("husky hook without install wiring is only configured", async () => {
		await put("package.json", manifest({ lint: "biome check ." }));
		await put(".husky/pre-commit", "bun run lint\n");
		const result = byId((await inspectSafeguards(repo)).results).get("pre-commit-hook");
		expect(result?.evidence).toBe("configured");
		expect(result?.notes).toContain("no husky install wiring");
	});

	test("a declarative husky key in the manifest is configured", async () => {
		await put("package.json", manifest({}, { husky: { hooks: { "pre-commit": "lint" } } }));
		const result = byId((await inspectSafeguards(repo)).results).get("pre-commit-hook");
		expect(result?.evidence).toBe("configured");
	});

	test("lefthook config is wired when a script references lefthook install", async () => {
		await put("package.json", manifest({ prepare: "lefthook install" }));
		await put("lefthook.yml", "pre-commit:\n  commands:\n    lint:\n      run: bun run lint\n");
		const result = byId((await inspectSafeguards(repo)).results).get("pre-commit-hook");
		expect(result?.evidence).toBe("structurally-wired");
		expect(result?.locations.map((l) => l.path)).toEqual(["lefthook.yml"]);
	});

	test("lefthook config alone is configured", async () => {
		await put("package.json", manifest({}));
		await put("lefthook.yaml", "pre-commit: {}\n");
		const result = byId((await inspectSafeguards(repo)).results).get("pre-commit-hook");
		expect(result?.evidence).toBe("configured");
	});

	test("pre-commit framework config is wired via the CI action or run reference", async () => {
		await put("package.json", manifest({}));
		await put(".pre-commit-config.yaml", "repos: []\n");
		await put(".github/workflows/ci.yml", workflow([], ["pre-commit/action@v3.0.1"]));
		const wired = byId((await inspectSafeguards(repo)).results).get("pre-commit-hook");
		expect(wired?.evidence).toBe("structurally-wired");
	});

	test("lefthook config is wired when a CI step references lefthook run", async () => {
		await put("package.json", manifest({}));
		await put("lefthook.yml", "pre-commit: {}\n");
		await put(".github/workflows/ci.yml", workflow(["lefthook run pre-commit"]));
		const result = byId((await inspectSafeguards(repo)).results).get("pre-commit-hook");
		expect(result?.evidence).toBe("structurally-wired");
		expect(result?.notes).toContain(".github/workflows/ci.yml");
	});

	test("pre-commit framework config alone is configured", async () => {
		await put("package.json", manifest({}));
		await put(".pre-commit-config.yml", "repos: []\n");
		const result = byId((await inspectSafeguards(repo)).results).get("pre-commit-hook");
		expect(result?.evidence).toBe("configured");
	});

	test("an unparseable YAML hook config is unknown, never guessed", async () => {
		await put("package.json", manifest({}));
		await put(".pre-commit-config.yaml", "repos: [unclosed\n");
		const result = byId((await inspectSafeguards(repo)).results).get("pre-commit-hook");
		expect(result?.evidence).toBe("unknown");
	});

	test("executable hook configuration is unknown and unverified", async () => {
		await put("package.json", manifest({}));
		await put("husky.config.js", "module.exports = {};\n");
		const result = byId((await inspectSafeguards(repo)).results).get("pre-commit-hook");
		expect(result?.evidence).toBe("unknown");
		expect(result?.notes).toContain("unverified");
	});

	test("a structurally-wired surface outranks an unknown executable config", async () => {
		await put("package.json", manifest({ prepare: "husky" }));
		await put(".husky/pre-commit", "bun run lint\n");
		await put("husky.config.js", "module.exports = {};\n");
		const result = byId((await inspectSafeguards(repo)).results).get("pre-commit-hook");
		expect(result?.evidence).toBe("structurally-wired");
		expect(result?.notes).toContain("unverified");
	});
});

describe("agent-hooks", () => {
	function settings(hooks: unknown): string {
		return JSON.stringify({ hooks }, null, "\t");
	}

	test("settings without a hooks map is absent", async () => {
		await put(".claude/settings.json", JSON.stringify({ permissions: {} }));
		const result = byId((await inspectSafeguards(repo)).results).get("agent-hooks");
		expect(result?.evidence).toBe("absent");
	});

	test("an unparseable settings file is unknown", async () => {
		await put(".claude/settings.json", "{ nope");
		const result = byId((await inspectSafeguards(repo)).results).get("agent-hooks");
		expect(result?.evidence).toBe("unknown");
	});

	test("a hook referencing a committed script is structurally-wired", async () => {
		await put(
			".claude/settings.json",
			settings({
				PreToolUse: [
					{ matcher: "Bash", hooks: [{ type: "command", command: "bash scripts/hooks/check.sh" }] },
				],
			}),
		);
		await put("scripts/hooks/check.sh", "#!/bin/sh\n");
		const result = byId((await inspectSafeguards(repo)).results).get("agent-hooks");
		expect(result?.evidence).toBe("structurally-wired");
	});

	test("a hook referencing a missing script is configured with a located finding", async () => {
		await put(
			".claude/settings.json",
			settings({
				PostToolUse: [
					{ matcher: "Edit", hooks: [{ type: "command", command: "bash scripts/hooks/lint.sh" }] },
				],
			}),
		);
		const inspection = await inspectSafeguards(repo);
		const result = byId(inspection.results).get("agent-hooks");
		expect(result?.evidence).toBe("configured");
		const finding = inspection.findings.find((f) => f.path === ".claude/settings.json");
		expect(finding?.kind).toBe("safeguard.broken-reference");
		expect(finding?.summary).toContain("scripts/hooks/lint.sh");
	});

	test("pure inline shell hooks are unknown — explicitly unverified", async () => {
		await put(
			".claude/settings.json",
			settings({
				PreToolUse: [
					{ matcher: "Bash", hooks: [{ type: "command", command: "jq -r .tool_input.command" }] },
				],
			}),
		);
		const result = byId((await inspectSafeguards(repo)).results).get("agent-hooks");
		expect(result?.evidence).toBe("unknown");
		expect(result?.notes).toContain("unverified");
	});

	test("a hook command needing JSON escapes still locates a finding at line 1", async () => {
		await put(
			".claude/settings.json",
			settings({
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [{ type: "command", command: 'echo "start" && bash scripts/hooks/missing.sh' }],
					},
				],
			}),
		);
		const inspection = await inspectSafeguards(repo);
		const finding = inspection.findings.find((f) => f.path === ".claude/settings.json");
		expect(finding?.summary).toContain("scripts/hooks/missing.sh");
		expect(finding?.range.start.line).toBe(1);
	});

	test("mixed verified and inline hooks are wired with an unverified note", async () => {
		await put(
			".claude/settings.json",
			settings({
				PreToolUse: [
					{ matcher: "Bash", hooks: [{ type: "command", command: "bash scripts/hooks/check.sh" }] },
					{ matcher: "Edit", hooks: [{ type: "command", command: "echo done | cat" }] },
				],
			}),
		);
		await put("scripts/hooks/check.sh", "#!/bin/sh\n");
		const result = byId((await inspectSafeguards(repo)).results).get("agent-hooks");
		expect(result?.evidence).toBe("structurally-wired");
		expect(result?.notes).toContain("arbitrary shell");
	});
});
