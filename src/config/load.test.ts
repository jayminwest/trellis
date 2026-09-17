import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILENAMES, loadAuditConfig, loadAuditConfigFile } from "./load.ts";

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
			policy: { budgets: {}, failOnNew: [], requireEvidence: [] },
		});
	});

	test("trellis.yaml is parsed and validated", async () => {
		await writeFile(
			join(repo, "trellis.yaml"),
			"source:\n  exclude:\n    - 'src/generated/**'\n  classify:\n    'scripts/tools/**': test\npolicy:\n  maxIndex: 40\n",
		);
		expect(await loadAuditConfig(repo)).toEqual({
			source: { exclude: ["src/generated/**"], classify: { "scripts/tools/**": "test" } },
			policy: { maxIndex: 40, budgets: {}, failOnNew: [], requireEvidence: [] },
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
			policy: { budgets: {}, failOnNew: [], requireEvidence: [] },
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

describe("loadAuditConfigFile", () => {
	test("an explicit file is parsed and validated", async () => {
		const path = join(repo, "anywhere.yaml");
		await writeFile(path, "policy:\n  maxIndex: 25\n");
		expect(await loadAuditConfigFile(path)).toEqual({
			source: { exclude: [], classify: {} },
			policy: { maxIndex: 25, budgets: {}, failOnNew: [], requireEvidence: [] },
		});
	});

	test("a missing explicit file is an operational error, never the defaults", async () => {
		await expect(loadAuditConfigFile(join(repo, "absent.yaml"))).rejects.toThrow(
			/cannot read config file/,
		);
	});

	test("an invalid explicit file names the path and the offending key", async () => {
		const path = join(repo, "bad.yaml");
		await writeFile(path, "policy:\n  maxIndex: 400\n");
		await expect(loadAuditConfigFile(path)).rejects.toThrow(/bad\.yaml/);
		await expect(loadAuditConfigFile(path)).rejects.toThrow(/policy\.maxIndex/);
	});
});
