import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILENAMES, loadAuditConfig } from "./load.ts";

let repo: string;

beforeEach(async () => {
	repo = await mkdtemp(join(tmpdir(), "trellis-cfg-"));
});

afterEach(async () => {
	await rm(repo, { recursive: true, force: true });
});

describe("loadAuditConfig", () => {
	test("a repo without a config file yields the documented defaults", async () => {
		expect(await loadAuditConfig(repo)).toEqual({
			source: { exclude: [], classify: {} },
			policy: { budgets: {}, failOnNew: [] },
		});
	});

	test("trellis.yaml is parsed and validated", async () => {
		await writeFile(
			join(repo, "trellis.yaml"),
			"source:\n  exclude:\n    - 'src/generated/**'\n  classify:\n    'scripts/tools/**': test\npolicy:\n  maxIndex: 40\n",
		);
		expect(await loadAuditConfig(repo)).toEqual({
			source: { exclude: ["src/generated/**"], classify: { "scripts/tools/**": "test" } },
			policy: { maxIndex: 40, budgets: {}, failOnNew: [] },
		});
	});

	test("trellis.yml is the fallback filename", async () => {
		expect(CONFIG_FILENAMES).toEqual(["trellis.yaml", "trellis.yml"]);
		await writeFile(join(repo, "trellis.yml"), "source:\n  exclude:\n    - 'dist/**'\n");
		const config = await loadAuditConfig(repo);
		expect(config.source.exclude).toEqual(["dist/**"]);
	});

	test("an empty config file yields defaults", async () => {
		await writeFile(join(repo, "trellis.yaml"), "");
		expect(await loadAuditConfig(repo)).toEqual({
			source: { exclude: [], classify: {} },
			policy: { budgets: {}, failOnNew: [] },
		});
	});

	test("unknown keys are rejected — configuration is pure data, never hooks", async () => {
		await writeFile(join(repo, "trellis.yaml"), "hooks:\n  pre-audit: rm -rf /\n");
		await expect(loadAuditConfig(repo)).rejects.toThrow(/invalid trellis\.yaml/);
	});

	test("invalid values name the offending key", async () => {
		await writeFile(join(repo, "trellis.yaml"), "policy:\n  maxIndex: 400\n");
		await expect(loadAuditConfig(repo)).rejects.toThrow(/policy\.maxIndex/);
	});
});
