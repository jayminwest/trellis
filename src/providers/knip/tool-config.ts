/**
 * Generated Knip configuration (SPEC §16.4, plan `pl-43c5` step 24 —
 * trellis-8ebc): translate the prepared reachability context (step 23,
 * `./context.ts`) into the **tool's own JSON configuration** plus the
 * minimal workspace manifest and TypeScript configuration the pinned tool
 * requires — all written by the reachability run into trellis-owned
 * scratch, never loaded from the target.
 *
 * - **No target configuration is ever read.** Knip auto-discovers
 *   `knip.json`/`knip.config.*` files and package manifests; the adapter
 *   passes an explicit `--config`/`--tsConfig` (both owned generated files)
 *   and stages a **source-only** view, so no ancestor or target
 *   configuration of the audited workspace can reach the analysis. The one
 *   manifest Knip needs to run at all is a trellis-generated minimal
 *   `package.json` written into the staged tree — the staged tree is
 *   trellis-owned scratch, never the target workspace.
 * - **The declared entry model, exactly.** `entry` is the prepared
 *   context's resolved roots (production entry files plus participating
 *   test roots — test files supply reachability evidence while staying
 *   classified `test`); `project` is the production candidate scope minus
 *   the entry roots (the tool includes entry files in its analyzed set by
 *   itself, and re-listing them would trip its redundant-pattern hint).
 *   Non-participating test files are outside both lists: they supply no
 *   evidence and are never candidates — the `tests: excluded` mode the
 *   research record ran.
 * - **The runtime plugin registry is explicitly disabled.** The research
 *   record disabled every plugin; the adapter derives the exact registry
 *   names from the pinned artifact's own registry file (a static read of a
 *   digest-verified distribution — never executed, never imported) and
 *   emits `false` for each, so no framework/tool plugin can load
 *   configuration or add entry conventions the declared model does not
 *   carry. An unreadable registry is a located refusal, never a guessed
 *   subset.
 * - **Deterministic scope.** Exact staged paths (glob-escaped, so a path
 *   containing `[](){}*?!+@|^` matches literally), `--no-gitignore` (no
 *   ambient ignore files can silently drop staged files),
 *   `--no-progress` (pure JSON stdout) and a neutralized findings exit code
 *   so exit status carries the tool's configuration-hint signal instead.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PreparedReachabilityContext } from "./context.ts";

/** The pinned artifact's runtime plugin registry file (read as text, never executed). */
export const KNIP_PLUGIN_REGISTRY_REL_PATH = "dist/plugins/index.js";

/** The minimal generated tsconfig the pinned tool needs (no `include`/`files` — never scope). */
export function knipTsConfig(): string {
	return `${JSON.stringify(
		{
			compilerOptions: {
				module: "ESNext",
				moduleResolution: "Bundler",
				allowImportingTsExtensions: true,
				noEmit: true,
			},
		},
		undefined,
		2,
	)}\n`;
}

/**
 * The minimal generated workspace manifest Knip requires to run: no
 * `main`/`exports`/`bin`/`scripts`/`workspaces` (no package-entry
 * conventions leak into the declared model), no dependencies (the
 * dependency context stays unverified — a recorded assumption), nothing
 * inherited from the target.
 */
export function knipWorkspaceManifest(): string {
	return `${JSON.stringify(
		{
			name: "trellis-staged-reachability-view",
			private: true,
			type: "module",
		},
		undefined,
		2,
	)}\n`;
}

/**
 * The glob metacharacters picomatch interprets: every one is backslash
 * escaped so an exact staged path matches literally.
 */
const GLOB_METACHARACTERS = new Set("*?[]{}!()+@|^\\".split(""));

/** Escape one exact repo-relative path into a literal glob pattern. */
export function escapeGlobPattern(path: string): string {
	return [...path].map((char) => (GLOB_METACHARACTERS.has(char) ? `\\${char}` : char)).join("");
}

/**
 * The names of every plugin in the pinned artifact's runtime registry,
 * derived by statically reading the registry module's export table (the
 * `Plugins` object literal) — a text read of a digest-verified distribution
 * file, never an import or execution of tool code. Sorting is canonical so
 * the generated configuration serializes deterministically.
 */
export function disabledPluginNames(packageRoot: string):
	| {
			names: string[];
	  }
	| {
			state: "unavailable";
			reason: string;
	  } {
	let text: string;
	try {
		text = readFileSync(join(packageRoot, KNIP_PLUGIN_REGISTRY_REL_PATH), "utf8");
	} catch {
		return {
			state: "unavailable",
			reason:
				`the pinned knip artifact has no readable "${KNIP_PLUGIN_REGISTRY_REL_PATH}" — the runtime ` +
				"plugin registry cannot be enumerated, so plugin discovery cannot be explicitly disabled",
		};
	}
	const match = /export const Plugins = \{\n([\s\S]*?)\n\};/.exec(text);
	if (match === null) {
		return {
			state: "unavailable",
			reason:
				`the pinned knip artifact's "${KNIP_PLUGIN_REGISTRY_REL_PATH}" does not carry the expected ` +
				"Plugins export table — the runtime plugin registry cannot be enumerated",
		};
	}
	const names = new Set<string>();
	for (const line of match[1]?.split("\n") ?? []) {
		const trimmed = line.trim().replace(/,$/, "");
		const quoted = /^'([^']+)':/.exec(trimmed);
		if (quoted !== null && quoted[1] !== undefined) {
			names.add(quoted[1]);
			continue;
		}
		const shorthand = /^([A-Za-z0-9_$-]+)$/.exec(trimmed);
		if (shorthand !== null && shorthand[1] !== undefined) {
			names.add(shorthand[1]);
		}
	}
	if (names.size === 0) {
		return {
			state: "unavailable",
			reason:
				"the pinned knip artifact's plugin registry enumerated to zero plugins — refusing to guess",
		};
	}
	return { names: [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) };
}

/**
 * The generated Knip configuration for one prepared reachability context:
 * every registry plugin disabled, the resolved roots as `entry`, the
 * production candidate scope (minus entry roots) as `project`. Deterministic
 * over the same context: sorted, exact, escaped paths.
 */
export function knipToolConfig(
	context: PreparedReachabilityContext,
	pluginNames: readonly string[],
): { entry: string[]; project: string[] } & Record<string, string[] | boolean> {
	const entryRoots = new Set(context.entryRoots);
	const entry = [...new Set([...context.entryRoots, ...context.testRoots])]
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
		.map(escapeGlobPattern);
	const project = context.projectFiles
		.filter((path) => !entryRoots.has(path))
		.map(escapeGlobPattern);
	const config: { entry: string[]; project: string[] } & Record<string, string[] | boolean> = {
		entry,
		project,
	};
	for (const name of pluginNames) {
		config[name] = false;
	}
	return config;
}

/** The staged paths the generated configuration submits as its analysis scope. */
export function knipConfiguredScope(context: PreparedReachabilityContext): string[] {
	return [...new Set([...context.entryRoots, ...context.testRoots, ...context.projectFiles])].sort(
		(a, b) => (a < b ? -1 : a > b ? 1 : 0),
	);
}

/**
 * The findings exit code is neutralized (`--max-issues` far above any real
 * candidate count) so the exit status carries exactly one meaning: Knip's
 * configuration-hint signal, promoted to an error
 * (`--treat-config-hints-as-errors`). Exit `0` — every submitted pattern
 * matched the staged scope and the run completed; exit `1` — the tool
 * reported a configuration hint (a submitted entry/project pattern matched
 * no staged file: an empty or partial analysis, located as incomplete,
 * never a clean pass); exit `2` — the tool could not run its analysis.
 */
export const KNIP_MAX_ISSUES_NEUTRALIZER = "1000000000";

/** The fixed argv one reachability pass runs (see the module docblock). */
export function knipInvocationArgs(paths: {
	directory: string;
	configPath: string;
	tsConfigPath: string;
}): string[] {
	return [
		"--directory",
		paths.directory,
		"--config",
		paths.configPath,
		"--tsConfig",
		paths.tsConfigPath,
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
	];
}
