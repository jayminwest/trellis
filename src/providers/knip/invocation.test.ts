import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnipProviderRequest } from "../../contract/index.ts";
import { analysisIdentitySchema, providerIdentitySchema } from "../../contract/index.ts";
import { resolvePinnedTool } from "../resolve.ts";
import type { StagedSelectionFile } from "../staging.ts";
import type { StagedWorkspaceView } from "../workspace.ts";
import { prepareReachabilityContext } from "./context.ts";
import {
	expectedKnipVersionOutput,
	InvalidKnipRequestError,
	KNIP_DEFAULT_MAX_OUTPUT_BYTES,
	KNIP_DEFAULT_TIMEOUT_MS,
	knipAnalysisIdentity,
	knipEnvironment,
	knipNeverRan,
	knipPinnedToolVersion,
	knipProviderIdentity,
	knipSourceSelection,
	normalizeKnipRequest,
	resolveKnipParser,
} from "./invocation.ts";
import { compileReachabilityPolicy } from "./policy.ts";

/**
 * Pinned knip invocation identity and request validation (plan `pl-43c5`
 * step 24 — trellis-8ebc): execution limits normalize with located
 * operational errors, the pin's exact `--version` output is recorded, the
 * tool's own `oxc-parser` is resolved (never assumed), and the provider and
 * analysis identities carry the prepared context's normalized configuration
 * identity through the step-6 compatibility seam.
 */

/** Real-artifact tests run only where the pinned knip resolved on this host. */
const TOOL_AVAILABLE = resolvePinnedTool("knip").state === "available";

/** A small prepared context over an inline selection. */
function contextOf(request: KnipProviderRequest = { entries: ["src/main.ts"] }) {
	const selection: StagedSelectionFile[] = [
		{ path: "src/main.ts", sourceSet: "production", packagePath: "." },
		{ path: "src/main.test.ts", sourceSet: "test", packagePath: "." },
	];
	return prepareReachabilityContext(compileReachabilityPolicy(request), selection);
}

/** A minimal structural staged view (the identity constructors read files only). */
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

describe("normalizeKnipRequest", () => {
	test("defaults the execution limits and passes the resolution seam through", () => {
		const normalized = normalizeKnipRequest();
		expect(normalized.timeoutMs).toBe(KNIP_DEFAULT_TIMEOUT_MS);
		expect(normalized.maxOutputBytes).toBe(KNIP_DEFAULT_MAX_OUTPUT_BYTES);
		expect(normalized.signal).toBeUndefined();
		expect(normalized.resolve).toEqual({});
		expect(normalizeKnipRequest({ timeoutMs: 5_000, maxOutputBytes: 2_048 }).timeoutMs).toBe(5_000);
	});

	test("rejects invalid limits and signals as operational errors", () => {
		for (const request of [
			{ timeoutMs: 0 },
			{ timeoutMs: -5 },
			{ timeoutMs: 1.5 },
			{ maxOutputBytes: 0 },
			{ signal: null as unknown as AbortSignal },
		]) {
			expect(() => normalizeKnipRequest(request as never)).toThrow(InvalidKnipRequestError);
		}
	});
});

describe("pinned version and parser resolution", () => {
	test("records the manifest's exact pinned version and --version output", () => {
		expect(knipPinnedToolVersion()).toBe("6.16.1");
		expect(expectedKnipVersionOutput()).toBe("6.16.1");
	});

	test.skipIf(!TOOL_AVAILABLE)(
		"resolves and records the oxc-parser the pinned tool finds locally",
		() => {
			const resolution = resolvePinnedTool("knip");
			if (resolution.state !== "available") throw new Error("expected an available pin");
			const parser = resolveKnipParser(resolution);
			expect("version" in parser).toBe(true);
			if (!("version" in parser)) throw new Error("expected a resolved parser");
			expect(parser.version).toMatch(/^\d+\.\d+\.\d+$/);
		},
	);

	test("refuses to run blind when no parser resolves, with located instructions", async () => {
		const scratch = await mkdtemp(join(tmpdir(), "trellis-knip-invocation-"));
		try {
			const resolution = {
				state: "available" as const,
				providerId: "knip",
				executablePath: join(scratch, "pkg/bin/knip-bun.js"),
				platformKey: "test",
				toolVersion: "6.16.1",
				binaryDigestVerified: true,
			};
			const parser = resolveKnipParser(resolution);
			expect("state" in parser).toBe(true);
			if (!("state" in parser)) throw new Error("expected a refusal");
			expect(parser.reason).toContain("resolves no local oxc-parser");
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
	});
});

describe("knip identities", () => {
	test("carries the prepared context's configuration identity in provider options", () => {
		const identity = knipProviderIdentity(contextOf({ entries: ["src/main.ts"], tests: "roots" }));
		expect(providerIdentitySchema.parse(identity)).toEqual(identity);
		expect(identity.kind).toBe("external");
		expect(identity.id).toBe("knip");
		expect(identity.mode).toBe("contextual");
		expect(identity.options["reachability-policy-version"]).toBe(1);
		expect(identity.options["reachability-test-mode"]).toBe("roots");
		expect(identity.options["plugin-registry"]).toBe("disabled");
		expect(identity.options.include).toBe("files,exports,types,unresolved");
	});

	test("records the staged selection, the tool's parser and the option set in analysis identity", () => {
		const context = contextOf();
		const view = stagedView(["src/b.ts", "src/a.ts"]);
		const identity = knipAnalysisIdentity(view, context, "0.133.0");
		expect(identity).toBeDefined();
		if (identity === undefined) throw new Error("expected an analysis identity");
		expect(analysisIdentitySchema.parse(identity)).toEqual(identity);
		expect(identity.selection.files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"]);
		expect(identity.parser).toEqual({ engine: "knip.oxc-parser", version: "0.133.0" });
		expect(knipSourceSelection(stagedView([]))).toBeUndefined();
	});

	test("locates a never-ran request with the context's own identity", () => {
		const result = knipNeverRan(contextOf(), "unavailable", "the reason");
		expect(result.state).toBe("unavailable");
		expect(result.reason).toBe("the reason");
		expect(result.provider.id).toBe("knip");
		expect(result.observedCoverage).toBeUndefined();
	});
});

describe("knipEnvironment", () => {
	test("gives the child exactly one owned home, nothing inherited", () => {
		expect(knipEnvironment("/owned/home")).toEqual({
			HOME: "/owned/home",
			USERPROFILE: "/owned/home",
		});
	});
});
