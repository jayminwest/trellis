import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadAuditConfig } from "./load.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "trellis-config-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
	const path = join(dir, name);
	writeFileSync(path, content);
	return path;
}

describe("loadAuditConfig", () => {
	test("loads and validates a full trellis.yaml", () => {
		const path = write(
			"trellis.yaml",
			[
				"source:",
				'  exclude: ["src/generated/**"]',
				"  classify:",
				'    "scripts/tools/**": test',
				"policy:",
				"  maxIndex: 40",
				"  budgets:",
				"    duplication.density:",
				"      max: 0.05",
				"  failOnNew: [import-cycle]",
				"",
			].join("\n"),
		);
		expect(loadAuditConfig(path)).toEqual({
			source: { exclude: ["src/generated/**"], classify: { "scripts/tools/**": "test" } },
			policy: {
				maxIndex: 40,
				budgets: { "duplication.density": { max: 0.05 } },
				failOnNew: ["import-cycle"],
			},
		});
	});

	test("yields the all-defaults configuration for an empty file", () => {
		expect(loadAuditConfig(write("trellis.yaml", ""))).toEqual({
			source: { exclude: [], classify: {} },
			policy: { budgets: {}, failOnNew: [] },
		});
	});

	test("rejects a schema violation with the file path in the error", () => {
		const path = write("trellis.yaml", "policy:\n  maxIndex: 400\n");
		expect(() => loadAuditConfig(path)).toThrow(ConfigError);
		expect(() => loadAuditConfig(path)).toThrow(path);
	});

	test("rejects a non-mapping document", () => {
		const path = write("trellis.yaml", "- just\n- a\n- list\n");
		expect(() => loadAuditConfig(path)).toThrow(ConfigError);
	});

	test("rejects malformed YAML", () => {
		const path = write("trellis.yaml", "source:\n\texclude: [unclosed\n");
		expect(() => loadAuditConfig(path)).toThrow(ConfigError);
	});

	test("rejects an unreadable file", () => {
		expect(() => loadAuditConfig(join(dir, "missing.yaml"))).toThrow(ConfigError);
	});
});
