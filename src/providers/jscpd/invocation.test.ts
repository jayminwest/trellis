import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	analysisIdentitySchema,
	measurementIdentity,
	providerIdentitySchema,
	providerOptionsSchema,
} from "../../contract/index.ts";
import { type StagedWorkspaceView, stageWorkspaceView } from "../workspace.ts";
import {
	expectedJscpdVersionOutput,
	InvalidJscpdRequestError,
	JSCPD_DEFAULT_THRESHOLDS,
	jscpdAnalysisIdentity,
	jscpdInvocationArgs,
	jscpdModeFlags,
	jscpdPinnedToolVersion,
	jscpdProviderIdentity,
	jscpdProviderOptions,
	sourceSelectionFromStagedView,
} from "./invocation.ts";

/** Stage a real temp workspace with the given files (real FS, per conventions). */
async function stageFiles(files: Record<string, string>): Promise<StagedWorkspaceView> {
	const root = await mkdtemp(join(tmpdir(), "trellis-jscpd-invocation-"));
	for (const [path, source] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), source);
	}
	return stageWorkspaceView({
		root,
		files: Object.keys(files).map((path) => ({
			path,
			sourceSet: "production" as const,
			packagePath: ".",
		})),
	});
}

/** Flags the adapter must never pass (target-directed or nondeterministic behavior). */
const FORBIDDEN_FLAGS = [
	"--exit-code",
	"--threshold",
	"--baseline",
	"--update-baseline",
	"--baseline-from-ref",
	"--blame",
	"--follow-symlinks",
	"--absolute",
	"--pattern",
	"--cross-formats",
	"--ignore-pattern",
];

describe("pinned invocation modes", () => {
	test("builds the mode flag sets from the research calibration", () => {
		expect(jscpdModeFlags("exact", JSCPD_DEFAULT_THRESHOLDS)).toEqual([]);
		expect(jscpdModeFlags("normalized", JSCPD_DEFAULT_THRESHOLDS)).toEqual([
			"--ignore-identifiers",
			"--ignore-literals",
		]);
		expect(jscpdModeFlags("near", JSCPD_DEFAULT_THRESHOLDS)).toEqual([
			"--ignore-identifiers",
			"--ignore-literals",
			"--max-gap-lines",
			"2",
			"--similarity",
			"0.85",
		]);
	});

	test("builds one fixed argv that pins the staged scope", () => {
		const args = jscpdInvocationArgs({
			stagedRoot: "/staged/root",
			configPath: "/work/config.json",
			outputDir: "/work/report-exact",
			mode: "near",
			thresholds: JSCPD_DEFAULT_THRESHOLDS,
		});
		expect(args[0]).toBe("/staged/root");
		// An explicit owned config and no gitignore: ancestor discovery cannot change scope.
		expect(args).toContain("--config");
		expect(args[args.indexOf("--config") + 1]).toBe("/work/config.json");
		expect(args).toContain("--no-gitignore");
		// The pinned detection behavior.
		expect(args).toContain("--mode");
		expect(args[args.indexOf("--mode") + 1]).toBe("weak");
		expect(args).toContain("--min-tokens");
		expect(args[args.indexOf("--min-tokens") + 1]).toBe("50");
		expect(args).toContain("--min-lines");
		expect(args[args.indexOf("--min-lines") + 1]).toBe("3");
		expect(args).toContain("--workers");
		expect(args[args.indexOf("--workers") + 1]).toBe("1");
		expect(args).toContain("--max-size");
		expect(args[args.indexOf("--max-size") + 1]).toBe("100mb");
		expect(args).toContain("--reporters");
		expect(args[args.indexOf("--reporters") + 1]).toBe("json");
		expect(args).toContain("--output");
		expect(args[args.indexOf("--output") + 1]).toBe("/work/report-exact");
		expect(args).toContain("--silent");
		expect(args).toContain("--no-tips");
		// The near-mode flags ride along; nothing forbidden ever appears.
		expect(args).toContain("--similarity");
		for (const flag of FORBIDDEN_FLAGS) {
			expect(args).not.toContain(flag);
		}
	});

	test("records the mode option sets as valid provider options", () => {
		const exact = jscpdProviderOptions("exact", JSCPD_DEFAULT_THRESHOLDS);
		expect(providerOptionsSchema.parse(exact)).toEqual(exact);
		expect(exact["ignore-identifiers"]).toBeUndefined();
		const near = jscpdProviderOptions("near", JSCPD_DEFAULT_THRESHOLDS);
		expect(near["ignore-identifiers"]).toBe(true);
		expect(near["ignore-literals"]).toBe(true);
		expect(near["max-gap-lines"]).toBe(2);
		expect(near.similarity).toBe(0.85);
		expect(near["min-tokens"]).toBe(50);
		expect(near.workers).toBe(1);
	});
});

describe("jscpd identity construction", () => {
	test("pins the manifest tool version and its expected version output", () => {
		expect(jscpdPinnedToolVersion()).toBe("5.2.1");
		expect(expectedJscpdVersionOutput()).toBe(`jscpd ${jscpdPinnedToolVersion()}`);
	});

	test("builds valid external provider identities whose measurement identity differs per mode", async () => {
		const view = await stageFiles({ "a.ts": "export const a = 1;\n" });
		try {
			const exact = jscpdProviderIdentity("exact", JSCPD_DEFAULT_THRESHOLDS);
			const near = jscpdProviderIdentity("near", JSCPD_DEFAULT_THRESHOLDS);
			expect(providerIdentitySchema.parse(exact)).toEqual(exact);
			expect(exact.kind).toBe("external");
			expect(exact.id).toBe("jscpd");
			expect(exact.mode).toBe("exact");
			expect(exact.adapterVersion).toBe("0.1.0");
			const exactIdentity = measurementIdentity(
				exact,
				jscpdAnalysisIdentity(view, "exact", JSCPD_DEFAULT_THRESHOLDS),
			);
			const nearIdentity = measurementIdentity(
				near,
				jscpdAnalysisIdentity(view, "near", JSCPD_DEFAULT_THRESHOLDS),
			);
			expect(nearIdentity).not.toBe(exactIdentity);
		} finally {
			await view.cleanup();
			await rm(view.root, { recursive: true, force: true });
		}
	});

	test("builds the analysis identity from a staged view with fingerprints and jscpd's parser", async () => {
		const view = await stageFiles({
			"a.ts": "export const a = 1;\n",
			"b.ts": "export const b = 2;\n",
		});
		try {
			const selection = sourceSelectionFromStagedView(view);
			expect(selection.sourceSets).toEqual(["production"]);
			expect(selection.files.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
			expect(selection.files[0]?.fingerprint).toBe(
				view.files.find((file) => file.path === "a.ts")?.sha256,
			);
			const analysis = jscpdAnalysisIdentity(view, "exact", JSCPD_DEFAULT_THRESHOLDS);
			expect(analysisIdentitySchema.parse(analysis)).toEqual(analysis);
			expect(analysis.parser).toEqual({ engine: "jscpd.tokenizer", version: "5.2.1" });
		} finally {
			await view.cleanup();
			await rm(view.root, { recursive: true, force: true });
		}
	});

	test("rejects an empty staged selection as an invalid request", async () => {
		const view = await stageFiles({});
		try {
			expect(() => sourceSelectionFromStagedView(view)).toThrow(InvalidJscpdRequestError);
		} finally {
			await view.cleanup();
			await rm(view.root, { recursive: true, force: true });
		}
	});
});
