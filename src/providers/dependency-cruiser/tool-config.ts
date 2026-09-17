/**
 * Generated dependency-cruiser configuration (SPEC §16.4, plan `pl-43c5`
 * step 22 — trellis-adbf): translate the compiled declarative architecture
 * policy (`./policy.ts`, trellis-89be) into the **tool's own JSON
 * configuration**, written by the cruise run into trellis-owned scratch —
 * never loaded from the target.
 *
 * - **No target configuration is ever read.** dependency-cruiser
 *   auto-discovers `.dependency-cruiser.*` files; the adapter passes an
 *   explicit `--config <owned file>` so no ancestor configuration of the
 *   target, the scratch parent, or the operator can change the evaluation
 *   (`./cruise-run.ts`).
 * - **Rule mapping.** `forbidden` boundaries and `cycle` rules map onto the
 *   tool's `forbidden` vocabulary (the only rules trellis generates); the
 *   declared edge kinds map onto the tool's dependency-type filters —
 *   `type-only` selects type-only edges, `runtime` excludes them — so
 *   runtime and type-only flavors are evaluated and reported separately,
 *   never merged (the research record). The `unresolved` rule maps onto
 *   `couldNotResolve`, scoped to **local** specifiers: external imports
 *   cannot resolve in the staged source view (no `node_modules` bodies are
 *   staged, ever), so they are preserved as stub evidence, never
 *   violations (`./normalize.ts`).
 * - **`allowed` boundaries are not tool rules.** The tool's own `allowed`
 *   section is a whitelist with different semantics ("not-in-allowed"
 *   for anything unmatched); trellis's `allowed` boundary is an explicit
 *   exception exempting a matching dependency from every `forbidden`
 *   boundary. The exception is applied in normalization from the compiled
 *   policy, recorded as visible evidence — never silently dropped.
 * - **A generated tsconfig, not the target's.** The minimal compiler
 *   options and the staged source `include` are generated into the owned
 *   scratch; nothing of the target's executable configuration is read.
 */
import type { CompiledArchitecturePolicy, CompiledArchitectureRule } from "./policy.ts";

/**
 * The edge-kind filter one rule carries in the tool's vocabulary:
 * `type-only` selects type-only edges, `runtime` excludes them, both
 * kinds govern every edge (no filter).
 */
export function edgeKindFilter(edges: readonly string[]): {
	dependencyTypes?: readonly ["type-only"];
	dependencyTypesNot?: readonly ["type-only"];
} {
	if (edges.length === 1 && edges[0] === "type-only") {
		return { dependencyTypes: ["type-only"] };
	}
	if (edges.includes("type-only")) {
		return {};
	}
	return { dependencyTypesNot: ["type-only"] };
}

/** One generated `forbidden` rule in the tool's own shape (never re-exported). */
function forbiddenRule(rule: object): object {
	return { severity: "error", ...rule };
}

/** The generated rule set: one forbidden tool rule per compiled forbidden rule. */
function forbiddenRules(rules: readonly CompiledArchitectureRule[]): object[] {
	const generated: object[] = [];
	for (const rule of rules) {
		switch (rule.kind) {
			case "boundary":
				if (rule.allowance === "forbidden") {
					generated.push(
						forbiddenRule({
							name: rule.name,
							from: { path: rule.from },
							to: { path: rule.to, ...edgeKindFilter(rule.edges) },
						}),
					);
				}
				break;
			case "cycle":
				generated.push(
					forbiddenRule({
						name: rule.name,
						from: {},
						to: { circular: true, ...edgeKindFilter(rule.edges) },
					}),
				);
				break;
			case "unresolved":
				generated.push(
					forbiddenRule({
						name: rule.name,
						from: {},
						to: {
							couldNotResolve: true,
							/** Local specifiers only: `./`, `../`, `/` and `#` — bare and `@scope/` externals stay stubs. */
							pathNot: "^[A-Za-z@]",
						},
					}),
				);
				break;
		}
	}
	return generated;
}

/**
 * The generated tool configuration, given the absolute paths the cruise run
 * owns (the config file and the generated tsconfig both live in the staged
 * view's owned `work/` area — machine paths that never enter identity).
 */
export function dependencyCruiserToolConfig(
	policy: CompiledArchitecturePolicy,
	paths: { tsConfigPath: string },
): {
	forbidden: object[];
	options: {
		doNotFollow: { path: string };
		tsPreCompilationDeps: boolean;
		tsConfig: { fileName: string };
		enhancedResolveOptions: { extensions: string[]; conditionNames: string[] };
	};
} {
	return {
		forbidden: forbiddenRules(policy.rules),
		options: {
			doNotFollow: { path: "node_modules" },
			tsPreCompilationDeps: true,
			tsConfig: { fileName: paths.tsConfigPath },
			enhancedResolveOptions: {
				extensions: [".ts", ".tsx", ".js", ".json"],
				conditionNames: ["import", "require", "node", "default"],
			},
		},
	};
}

/**
 * The generated TypeScript configuration: the minimal compiler shape the
 * staged source view needs (ES modules, bundler resolution, explicit `.ts`
 * import extensions), `include`-ing exactly the staged `source/` tree
 * relative to the owned scratch — a trellis-owned file, never the target's.
 */
export function dependencyCruiserTsConfig(): string {
	return `${JSON.stringify(
		{
			compilerOptions: {
				module: "ESNext",
				moduleResolution: "Bundler",
				allowImportingTsExtensions: true,
				noEmit: true,
			},
			include: ["../source/**/*"],
		},
		undefined,
		2,
	)}\n`;
}

/**
 * The fixed argv one cruise runs: the staged scope as the current
 * directory (so reported module sources are the selection's repo-relative
 * paths and the declared selectors match them), the owned generated config
 * (blocking ancestor discovery), and JSON to stdout. Never a target path,
 * never a script, never a download.
 */
export function dependencyCruiserInvocationArgs(configPath: string): string[] {
	return ["--config", configPath, "--output-type", "json", "."];
}

/** The names of the forbidden rules the generated configuration declares (the raw-report validation set). */
export function generatedRuleNames(policy: CompiledArchitecturePolicy): Set<string> {
	return new Set(
		policy.rules
			.filter((rule) => rule.kind !== "boundary" || rule.allowance === "forbidden")
			.map((rule) => rule.name),
	);
}
