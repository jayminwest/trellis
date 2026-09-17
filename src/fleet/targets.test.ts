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
	targetDriftOptions,
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
		expect(fleet.targets.map((t) => t.spec.id)).toEqual(["warren", "trellis", "external-repo"]);
		expect(fleet.defaults.canonicalVersion).toBe("1.0.0");
		// The relative target path resolves off the fleet-file directory, not cwd.
		const external = fleet.targets[2];
		expect(external?.spec.path).toBe("../some-non-oseco-repo");
		expect(isAbsolute(external?.absPath ?? "")).toBe(true);
		expect(external?.absPath).toBe(resolve(fleet.baseDir, "../some-non-oseco-repo"));
	});

	test("resolves relative target paths and config against the targets.yaml directory", async () => {
		const fleet = await loadYaml(
			dir,
			"targets:\n  - id: a\n    path: ./sub/a\n    config: ./configs/a.yaml\n  - id: b\n    path: /abs/b\n",
		);
		expect(fleet.baseDir).toBe(dir);
		expect(fleet.targets[0]?.absPath).toBe(resolve(dir, "sub/a"));
		expect(fleet.targets[0]?.absConfigPath).toBe(resolve(dir, "configs/a.yaml"));
		expect(fleet.targets[1]?.absPath).toBe(resolve("/abs/b"));
		expect(fleet.targets[1]?.absConfigPath).toBeUndefined();
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

	test("rejects a retired readiness skip with an actionable migration message", async () => {
		let caught: unknown;
		try {
			await loadYaml(dir, "targets:\n  - id: warren\n    path: a\n    skip: [dast_scanning]\n");
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(TargetsError);
		expect((caught as Error).message).toContain("target 'warren'.skip");
		expect((caught as Error).message).toContain("no longer exists");
		expect((caught as Error).message).toContain("Remove target 'warren'.skip");
	});

	test("rejects a retired language hint with an actionable migration message", async () => {
		let caught: unknown;
		try {
			await loadYaml(dir, "targets:\n  - id: app\n    path: a\n    languages: [swift]\n");
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(TargetsError);
		expect((caught as Error).message).toContain("target 'app'.languages");
		expect((caught as Error).message).toContain("no longer exists");
		expect((caught as Error).message).toContain("Remove target 'app'.languages");
	});
});

describe("targetDriftOptions", () => {
	/** Build a resolved target from a spec, with a fixed absolute path. */
	function resolved(spec: ResolvedTarget["spec"]): ResolvedTarget {
		return { spec, absPath: `/abs/${spec.id}` };
	}

	test("plumbs the id, resolved version, and allowed deltas into the drift options", () => {
		const opts = targetDriftOptions(
			resolved({
				id: "warren",
				path: "warren",
				canonical: {
					version: "1.0.0",
					allowedDeltas: [{ file: "biome.json", reason: "wider line width" }],
				},
			}),
			{ canonicalVersion: "0.9.0" },
		);
		expect(opts.repoId).toBe("warren");
		// Per-repo canonical version overrides the fleet default.
		expect(opts.canonicalVersion).toBe("1.0.0");
		expect(opts.allowedDeltas).toEqual([{ file: "biome.json", reason: "wider line width" }]);
	});

	test("falls back to the fleet default canonical version when the target omits one", () => {
		const opts = targetDriftOptions(resolved({ id: "a", path: "a" }), {
			canonicalVersion: "2.3.4",
		});
		expect(opts.canonicalVersion).toBe("2.3.4");
		expect(opts.repoId).toBe("a");
	});

	test("omits optional knobs the target does not set", () => {
		const opts = targetDriftOptions(resolved({ id: "a", path: "a" }), {});
		// With no version anywhere, drift falls through to the bundled set.
		expect(opts.canonicalVersion).toBeUndefined();
		expect(opts.allowedDeltas).toBeUndefined();
	});
});
