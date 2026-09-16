import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
	type Fleet,
	loadFleet,
	type ResolvedTarget,
	TARGETS_FILE,
	TargetsError,
	targetAuditOptions,
} from "./targets.ts";

/** Write `body` to `<dir>/targets.yaml` and load it; returns the loaded fleet. */
async function loadYaml(dir: string, body: string): Promise<Fleet> {
	const file = join(dir, TARGETS_FILE);
	await writeFile(file, body);
	return loadFleet(file);
}

describe("loadFleet", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "trellis-fleet-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("loads the bundled targets.yaml.example and resolves its paths", () => {
		const fleet = loadFleet("targets.yaml.example");
		expect(fleet.targets.map((t) => t.spec.id)).toEqual([
			"warren",
			"my-swift-app",
			"external-repo",
		]);
		expect(fleet.defaults.canonicalVersion).toBe("1.0.0");
		// The relative target path resolves off the fleet-file directory, not cwd.
		const external = fleet.targets[2];
		expect(external?.spec.path).toBe("../some-non-oseco-repo");
		expect(isAbsolute(external?.absPath ?? "")).toBe(true);
		expect(external?.absPath).toBe(resolve(fleet.baseDir, "../some-non-oseco-repo"));
	});

	test("resolves relative target paths against the targets.yaml directory", async () => {
		const fleet = await loadYaml(
			dir,
			"targets:\n  - id: a\n    path: ./sub/a\n  - id: b\n    path: /abs/b\n",
		);
		expect(fleet.baseDir).toBe(dir);
		expect(fleet.targets[0]?.absPath).toBe(resolve(dir, "sub/a"));
		expect(fleet.targets[1]?.absPath).toBe(resolve("/abs/b"));
	});

	test("rejects an unreadable / missing fleet file", () => {
		expect(() => loadFleet(join(dir, "nope.yaml"))).toThrow(TargetsError);
	});

	test("rejects a duplicate target id", async () => {
		await expect(
			loadYaml(dir, "targets:\n  - id: dup\n    path: a\n  - id: dup\n    path: b\n"),
		).rejects.toThrow(/duplicate target id/);
	});

	test("rejects an unknown key (strict schema)", async () => {
		await expect(
			loadYaml(dir, "targets:\n  - id: a\n    path: a\n    bogus: true\n"),
		).rejects.toThrow(TargetsError);
	});

	test("rejects a non-semver canonical version", async () => {
		await expect(
			loadYaml(dir, "targets:\n  - id: a\n    path: a\n    canonical:\n      version: latest\n"),
		).rejects.toThrow(/semver/);
	});

	test("rejects an unknown language enum value", async () => {
		await expect(
			loadYaml(dir, "targets:\n  - id: a\n    path: a\n    languages: [cobol]\n"),
		).rejects.toThrow(TargetsError);
	});

	test("rejects an empty targets list", async () => {
		await expect(loadYaml(dir, "targets: []\n")).rejects.toThrow(TargetsError);
	});

	test("defaults to an empty defaults object when omitted", async () => {
		const fleet = await loadYaml(dir, "targets:\n  - id: a\n    path: a\n");
		expect(fleet.defaults).toEqual({});
	});

	test("rejects retired defaults.investigation with an actionable message", async () => {
		const body =
			"defaults:\n  investigation:\n    provider: anthropic\n    model: claude-opus-4-8\n" +
			"targets:\n  - id: a\n    path: a\n";
		let caught: unknown;
		try {
			await loadYaml(dir, body);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(TargetsError);
		expect((caught as Error).message).toContain("defaults.investigation");
		expect((caught as Error).message).toContain("no longer exists");
		expect((caught as Error).message).toContain("Remove defaults.investigation");
	});
});

describe("targetAuditOptions", () => {
	/** Build a resolved target from a spec, with a fixed absolute path. */
	function resolved(spec: ResolvedTarget["spec"]): ResolvedTarget {
		return { spec, absPath: `/abs/${spec.id}` };
	}

	test("plumbs skip, osecoDetectors, languages, and allowed deltas into the audit options", () => {
		const opts = targetAuditOptions(
			resolved({
				id: "warren",
				path: "warren",
				languages: ["typescript"],
				skip: ["dast_scanning"],
				osecoDetectors: false,
				canonical: {
					version: "1.0.0",
					allowedDeltas: [{ file: "biome.json", reason: "wider line width" }],
				},
			}),
			{ canonicalVersion: "0.9.0" },
		);
		expect(opts.repoId).toBe("warren");
		expect(opts.skip).toEqual(["dast_scanning"]);
		expect(opts.osecoDetectors).toBe(false);
		expect(opts.languages).toEqual(["typescript"]);
		expect(opts.canonical?.repoId).toBe("warren");
		// Per-repo canonical version overrides the fleet default.
		expect(opts.canonical?.canonicalVersion).toBe("1.0.0");
		expect(opts.canonical?.allowedDeltas).toEqual([
			{ file: "biome.json", reason: "wider line width" },
		]);
	});

	test("falls back to the fleet default canonical version when the target omits one", () => {
		const opts = targetAuditOptions(resolved({ id: "a", path: "a" }), {
			canonicalVersion: "2.3.4",
		});
		expect(opts.canonical?.canonicalVersion).toBe("2.3.4");
		expect(opts.canonical?.repoId).toBe("a");
	});

	test("omits optional knobs the target does not set", () => {
		const opts = targetAuditOptions(resolved({ id: "a", path: "a" }), {});
		expect(opts.skip).toBeUndefined();
		expect(opts.languages).toBeUndefined();
		expect(opts.osecoDetectors).toBeUndefined();
		// Drift still runs; with no version anywhere it falls through to the bundled set.
		expect(opts.canonical?.canonicalVersion).toBeUndefined();
		expect(opts.canonical?.allowedDeltas).toBeUndefined();
	});
});
