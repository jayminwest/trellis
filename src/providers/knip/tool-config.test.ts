import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePinnedTool } from "../resolve.ts";
import type { StagedSelectionFile } from "../staging.ts";
import { prepareReachabilityContext } from "./context.ts";
import { compileReachabilityPolicy } from "./policy.ts";
import {
	disabledPluginNames,
	escapeGlobPattern,
	KNIP_MAX_ISSUES_NEUTRALIZER,
	knipConfiguredScope,
	knipInvocationArgs,
	knipToolConfig,
	knipTsConfig,
	knipWorkspaceManifest,
} from "./tool-config.ts";

/**
 * Generated knip configuration (plan `pl-43c5` step 24 — trellis-8ebc): the
 * declared entry model translates exactly (roots as entry, production scope
 * minus entry roots as project — re-listing an entry would trip the tool's
 * redundant-pattern hint), glob metacharacters in exact paths are escaped,
 * the runtime plugin registry is enumerated from the pinned artifact and
 * every plugin is disabled, and the fixed argv neutralizes the findings exit
 * code so the exit status carries the configuration-hint signal.
 */

/** Real-artifact tests run only where the pinned knip resolved on this host. */
const TOOL_AVAILABLE = resolvePinnedTool("knip").state === "available";

/** The pinned knip package root, when it resolved. */
function pinnedPackageRoot(): string | undefined {
	const resolution = resolvePinnedTool("knip");
	if (resolution.state !== "available") return undefined;
	return resolution.executablePath.replace(/\/bin\/[^/]+$/, "");
}

/** A prepared context over a small inline selection, for config generation. */
function contextOf(
	request: Parameters<typeof compileReachabilityPolicy>[0],
): ReturnType<typeof prepareReachabilityContext> {
	const selection: StagedSelectionFile[] = [
		{ path: "src/main.ts", sourceSet: "production", packagePath: "." },
		{ path: "src/live.ts", sourceSet: "production", packagePath: "." },
		{ path: "src/main.test.ts", sourceSet: "test", packagePath: "." },
	];
	return prepareReachabilityContext(compileReachabilityPolicy(request), selection);
}

describe("escapeGlobPattern", () => {
	test("escapes every picomatch metacharacter so exact paths match literally", () => {
		expect(escapeGlobPattern("src/[x]/util.ts")).toBe("src/\\[x\\]/util.ts");
		expect(escapeGlobPattern("src/(paren)/u.ts")).toBe("src/\\(paren\\)/u.ts");
		expect(escapeGlobPattern("a*b?c")).toBe("a\\*b\\?c");
		expect(escapeGlobPattern("a{b}c!d+e@f|g^h\\i")).toBe("a\\{b\\}c\\!d\\+e\\@f\\|g\\^h\\\\i");
		expect(escapeGlobPattern("src/plain/util.ts")).toBe("src/plain/util.ts");
	});
});

describe("disabledPluginNames", () => {
	test.skipIf(!TOOL_AVAILABLE)(
		"enumerates the pinned artifact's runtime registry, covering every config-schema plugin",
		() => {
			const root = pinnedPackageRoot();
			if (root === undefined) throw new Error("the pinned knip did not resolve");
			const plugins = disabledPluginNames(root);
			if ("state" in plugins) throw new Error(`registry enumeration failed: ${plugins.reason}`);
			expect(plugins.names.length).toBeGreaterThan(100);
			expect(plugins.names).toEqual([...plugins.names].sort());
			for (const known of ["next", "vite", "typescript", "node", "dependency-cruiser"]) {
				expect(plugins.names).toContain(known);
			}
			// Cross-check against the pinned artifact's own config schema: the
			// runtime registry must cover every plugin name the schema accepts.
			const schemaText = readFileSync(join(root, "dist/schema/plugins.js"), "utf8");
			const schemaNames = [
				...schemaText.matchAll(/^\s{4}(?:'([^']+)'|([a-zA-Z-]+)): pluginSchema,/gm),
			].map((match) => match[1] ?? match[2] ?? "");
			expect(schemaNames.length).toBeGreaterThan(100);
			for (const name of schemaNames) {
				expect(plugins.names).toContain(name);
			}
		},
	);

	test("reports an unreadable registry as a located refusal, never a guessed subset", async () => {
		const dir = await mkdtemp(join(tmpdir(), "trellis-knip-config-"));
		try {
			const plugins = disabledPluginNames(dir);
			expect("state" in plugins).toBe(true);
			if (!("state" in plugins)) throw new Error("expected a refusal");
			expect(plugins.reason).toContain("has no readable");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("refuses a registry that parses to zero plugins or no export table", async () => {
		const dir = await mkdtemp(join(tmpdir(), "trellis-knip-config-"));
		try {
			await mkdir(join(dir, "dist/plugins"), { recursive: true });
			const registryPath = join(dir, "dist/plugins/index.js");
			await writeFile(registryPath, "export const Plugins = {};\n");
			const empty = disabledPluginNames(dir);
			expect("state" in empty).toBe(true);

			await writeFile(registryPath, "export const Other = { a: 1 };\n");
			const missing = disabledPluginNames(dir);
			expect("state" in missing).toBe(true);
			if (!("state" in missing)) throw new Error("expected a refusal");
			expect(missing.reason).toContain("does not carry the expected");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("knipToolConfig", () => {
	test("translates the declared entry model exactly: roots as entry, scope minus roots as project", () => {
		const context = contextOf({
			entries: ["src/main.ts"],
			tests: "roots",
		});
		const config = knipToolConfig(context, ["node", "vite"]);
		expect(config.entry).toEqual(["src/main.test.ts", "src/main.ts"]);
		// The entry root is not re-listed as a project pattern (the tool would
		// hint it redundant); the production scope carries the rest.
		expect(config.project).toEqual(["src/live.ts"]);
		expect(config.node).toBe(false);
		expect(config.vite).toBe(false);
	});

	test("escapes glob metacharacters in every generated pattern", () => {
		const selection: StagedSelectionFile[] = [
			{ path: "src/[x]/util.ts", sourceSet: "production", packagePath: "." },
		];
		const context = prepareReachabilityContext(
			compileReachabilityPolicy({ entries: ["src/[x]/util.ts"] }),
			selection,
		);
		const config = knipToolConfig(context, []);
		expect(config.entry).toEqual(["src/\\[x\\]/util.ts"]);
		expect(config.project).toEqual([]);
		expect(knipConfiguredScope(context)).toEqual(["src/[x]/util.ts"]);
	});

	test("excludes non-participating test files from every pattern", () => {
		const context = contextOf({ entries: ["src/main.ts"] });
		const config = knipToolConfig(context, []);
		expect(config.entry).toEqual(["src/main.ts"]);
		expect(config.project).toEqual(["src/live.ts"]);
	});
});

describe("generated tool files and argv", () => {
	test("generates the minimal workspace manifest with no entry or dependency conventions", () => {
		const manifest = JSON.parse(knipWorkspaceManifest()) as Record<string, unknown>;
		expect(manifest.name).toBe("trellis-staged-reachability-view");
		expect(manifest.private).toBe(true);
		for (const leaked of ["main", "exports", "bin", "scripts", "workspaces", "dependencies"]) {
			expect(manifest[leaked]).toBeUndefined();
		}
	});

	test("generates a minimal tsconfig without include or files (never scope)", () => {
		const tsconfig = JSON.parse(knipTsConfig()) as Record<string, unknown>;
		expect(Object.keys(tsconfig)).toEqual(["compilerOptions"]);
	});

	test("fixes the argv: neutralized findings exit code, hints as errors, no plugins-by-accident", () => {
		const args = knipInvocationArgs({
			directory: "/staged",
			configPath: "/work/knip.json",
			tsConfigPath: "/work/tsconfig.json",
		});
		expect(args).toEqual([
			"--directory",
			"/staged",
			"--config",
			"/work/knip.json",
			"--tsConfig",
			"/work/tsconfig.json",
			"--reporter",
			"json",
			"--include",
			"files,exports,types,unresolved",
			"--no-tag-hints",
			"--no-progress",
			"--no-gitignore",
			"--max-issues",
			KNIP_MAX_ISSUES_NEUTRALIZER,
			"--treat-config-hints-as-errors",
		]);
		expect(Number.parseInt(KNIP_MAX_ISSUES_NEUTRALIZER, 10)).toBeGreaterThan(1_000_000);
	});
});
