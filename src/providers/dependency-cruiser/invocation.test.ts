/**
 * Invocation identity and asset-resolution tests (plan `pl-43c5` step 22 —
 * trellis-adbf): requests validate before anything runs, identities carry
 * the compiled policy's normalized identity fragment and the parser
 * context actually resolved (never an assumed compiler), and the pinned
 * pure-JavaScript launcher composes under trellis's own runtime with an
 * owned minimal environment.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DependencyCruiserProviderRequest } from "../../contract/index.ts";
import { resolvePinnedTool } from "../resolve.ts";
import type { StagedWorkspaceView } from "../workspace.ts";
import {
	DEPENDENCY_CRUISER_DEFAULT_MAX_OUTPUT_BYTES,
	DEPENDENCY_CRUISER_DEFAULT_TIMEOUT_MS,
	dependencyCruiserAnalysisIdentity,
	dependencyCruiserEnvironment,
	dependencyCruiserProviderIdentity,
	dependencyCruiserProviderOptions,
	expectedDependencyCruiserVersionOutput,
	InvalidDependencyCruiserRequestError,
	normalizeDependencyCruiserRequest,
	pinnedLauncherInvocation,
	resolveDependencyCruiserTypescript,
	sourceSelectionFromStagedView,
} from "./invocation.ts";
import { compileArchitecturePolicy } from "./policy.ts";
import { DEPENDENCY_CRUISER_ADAPTER_VERSION, DEPENDENCY_CRUISER_PARSER_ENGINE } from "./raw.ts";

/** One simple policy the identity tests compile. */
const REQUEST: DependencyCruiserProviderRequest = {
	rules: [{ kind: "cycle", name: "no-cycles", edges: ["runtime"] }],
};

/** A minimal structural staged view (the identity constructors read files and source sets only). */
function stagedView(paths: readonly string[]): StagedWorkspaceView {
	return {
		files: paths.map((path) => ({
			path,
			stagedPath: path,
			sourceSet: "production" as const,
			packagePath: ".",
			sha256: "0".repeat(64),
			bytes: 0,
		})),
	} as unknown as StagedWorkspaceView;
}

let scratch: string;

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "trellis-dc-invocation-"));
});

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true });
});

describe("normalizeDependencyCruiserRequest", () => {
	test("defaults to the pinned execution limits and the real resolution environment", () => {
		expect(normalizeDependencyCruiserRequest()).toEqual({
			timeoutMs: DEPENDENCY_CRUISER_DEFAULT_TIMEOUT_MS,
			maxOutputBytes: DEPENDENCY_CRUISER_DEFAULT_MAX_OUTPUT_BYTES,
			signal: undefined,
			resolve: {},
		});
	});

	test("rejects non-positive and non-integer limits, and non-signal cancellation handles", () => {
		for (const bad of [0, -1, 1.5]) {
			expect(() => normalizeDependencyCruiserRequest({ timeoutMs: bad })).toThrow(
				InvalidDependencyCruiserRequestError,
			);
			expect(() => normalizeDependencyCruiserRequest({ maxOutputBytes: bad })).toThrow(
				InvalidDependencyCruiserRequestError,
			);
		}
		expect(() =>
			normalizeDependencyCruiserRequest({ signal: null as unknown as AbortSignal }),
		).toThrow(InvalidDependencyCruiserRequestError);
	});
});

describe("dependency-cruiser identity", () => {
	test("carries the compiled policy's identity fragment and the pinned invocation flags", () => {
		const policy = compileArchitecturePolicy(REQUEST);
		const identity = dependencyCruiserProviderIdentity(policy);
		expect(identity).toEqual({
			kind: "external",
			id: "dependency-cruiser",
			toolVersion: "18.3.1",
			adapterVersion: DEPENDENCY_CRUISER_ADAPTER_VERSION,
			mode: "declared-rules",
			options: dependencyCruiserProviderOptions(policy),
		});
		expect(identity.options["architecture-policy-digest"]).toBe(`sha256:${policy.digest}`);
		expect(identity.options["architecture-rule-count"]).toBe(1);
		expect(identity.options["ts-pre-compilation-deps"]).toBe(true);
	});

	test("records the staged selection and the tool's own parser identity, never trellis's", () => {
		const policy = compileArchitecturePolicy(REQUEST);
		const view = stagedView(["src/b.ts", "src/a.ts"]);
		const identity = dependencyCruiserAnalysisIdentity(view, policy, "5.9.3");
		expect(identity?.parser).toEqual({
			engine: DEPENDENCY_CRUISER_PARSER_ENGINE,
			version: "5.9.3",
		});
		expect(identity?.selection.files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"]);
		expect(sourceSelectionFromStagedView(stagedView([]))).toBeUndefined();
	});
});

describe("resolveDependencyCruiserTypescript", () => {
	test("resolves and records the compiler the pinned tool finds locally", () => {
		const resolution = resolvePinnedTool("dependency-cruiser");
		// The pinned artifact is a devDependency of this repository; where it
		// resolved, the tool's parser chain is this repository's install.
		if (resolution.state !== "available") return;
		const parser = resolveDependencyCruiserTypescript(resolution);
		expect("version" in parser).toBe(true);
		if ("version" in parser) expect(parser.version).toMatch(/^\d+\.\d+\.\d+$/);
	});

	test("reports a located unavailable outcome when the chain carries no TypeScript compiler", () => {
		const resolution = {
			state: "available" as const,
			providerId: "dependency-cruiser",
			executablePath: join(scratch, "pkg", "bin", "dependency-cruiser.mjs"),
			platformKey: "test",
			toolVersion: "18.3.1",
			binaryDigestVerified: true,
		};
		const parser = resolveDependencyCruiserTypescript(resolution);
		expect("state" in parser).toBe(true);
		if ("state" in parser) {
			expect(parser.reason).toContain("no local TypeScript compiler");
			expect(parser.reason).toContain("empty graph");
		}
	});

	test("keeps walking when a malformed typescript package.json blocks one level", async () => {
		const pkg = join(scratch, "pkg", "bin");
		await mkdir(pkg, { recursive: true });
		// A garbage nested package.json at the first level must not end the walk:
		// the walk continues upward to this scratch's own valid typescript install.
		await mkdir(join(scratch, "pkg", "node_modules", "typescript"), { recursive: true });
		await writeFile(
			join(scratch, "pkg", "node_modules", "typescript", "package.json"),
			"not json at all",
		);
		await mkdir(join(scratch, "node_modules", "typescript"), { recursive: true });
		await writeFile(
			join(scratch, "node_modules", "typescript", "package.json"),
			JSON.stringify({ name: "typescript", version: "5.9.3" }),
		);
		const parser = resolveDependencyCruiserTypescript({
			state: "available",
			providerId: "dependency-cruiser",
			executablePath: join(pkg, "dependency-cruiser.mjs"),
			platformKey: "test",
			toolVersion: "18.3.1",
			binaryDigestVerified: true,
		});
		if (!("version" in parser)) throw new Error("expected the walk to find the valid compiler");
		expect(parser.version).toBe("5.9.3");
	});
});

describe("pinnedLauncherInvocation", () => {
	test("runs the pinned pure-JavaScript launcher under trellis's own runtime, never a PATH lookup", () => {
		const resolution = resolvePinnedTool("dependency-cruiser");
		if (resolution.state !== "available") return;
		const invocation = pinnedLauncherInvocation(resolution);
		expect(invocation.interpreter.id).toBe("bun");
		expect(invocation.launcher.path).toBe(resolution.executablePath);
		expect(invocation.args).toEqual([resolution.executablePath]);
	});
});

describe("dependencyCruiserEnvironment", () => {
	test("is exactly one trellis-owned home directory — nothing inherited", () => {
		expect(dependencyCruiserEnvironment("/owned/home")).toEqual({
			HOME: "/owned/home",
			USERPROFILE: "/owned/home",
		});
	});
});

describe("expectedDependencyCruiserVersionOutput", () => {
	test("names the manifest pin the invocation verifies against", () => {
		expect(expectedDependencyCruiserVersionOutput()).toBe("18.3.1");
	});
});
