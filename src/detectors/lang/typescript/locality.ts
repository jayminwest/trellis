/**
 * TypeScript adapter — §5.9 Locality & Contracts detectors (the thesis category).
 *
 * "Maximize locality of reasoning, minimize invisible contracts," as enforced
 * lints. The stack-concept criteria (`explicit_any_detection`, `greppable_exports`,
 * `barrel_file_reexport_detection`, `strictest_type_checking`) have a real
 * TypeScript analogue, so they grade pass/fail here — `not-applicable` is what
 * the Swift/Python adapters return for them (SPEC §5.9). `import_cycle_detection`
 * is computed exactly from the relative-import graph (no tool needed — a cycle is
 * unambiguous). The optional-tooling criteria (`machine_checked_architecture`,
 * `mutation_testing`) and the entrypoint-dependent `orphan_module_detection`
 * delegate to a configured analyzer, mapping honest absence to fail/N-A per §3.2.
 */
import { packageDeps, packageScripts, readJson } from "../../common/util.ts";
import { type Detector, fail, noDetector, notApplicable, pass } from "../../types.ts";
import { buildImportGraph, findCycle } from "./graph.ts";
import {
	biomeLinterEnabled,
	biomeRuleLevel,
	depsHasAny,
	findBiomeConfig,
	findEslintConfig,
	flag,
	loadTsConfig,
	scriptMatches,
	tsSources,
} from "./util.ts";

/** `machine_checked_architecture` (A/L4, S): architecture as enforced import/layering constraints. */
export const machineCheckedArchitecture: Detector = async (ctx) => {
	const pkg = await readJson(ctx, "package.json");
	if (depsHasAny(packageDeps(pkg), ["dependency-cruiser", "eslint-plugin-boundaries"])) {
		return pass("architecture enforced via dependency-cruiser / eslint-plugin-boundaries");
	}
	for (const rel of [
		".dependency-cruiser.js",
		".dependency-cruiser.cjs",
		".dependency-cruiser.json",
	]) {
		if ((await ctx.readFile(rel)) !== null)
			return pass(`dependency-cruiser rules present: '${rel}'`);
	}
	const arch = await tsSources(ctx);
	if (arch.some((f) => /\.arch\.test\.(ts|tsx)$/.test(f))) {
		return pass("architecture constraints enforced by an `*.arch.test.ts` suite");
	}
	return notApplicable("no machine-checked architecture constraints configured (skippable → N/A)");
};

/** `import_cycle_detection` (A/L4, GATE): the import graph is acyclic. */
export const importCycleDetection: Detector = async (ctx) => {
	const graph = await buildImportGraph(ctx);
	if (graph.size === 0)
		return noDetector("no TypeScript sources found to analyze for import cycles");
	const cycle = findCycle(graph);
	if (cycle === null) return pass(`import graph acyclic across ${graph.size} module(s)`);
	return fail(`import cycle detected: ${cycle.join(" → ")}`);
};

/** `orphan_module_detection` (A/L3): no whole unreachable files (delegated to knip/ts-prune). */
export const orphanModuleDetection: Detector = async (ctx) => {
	const pkg = await readJson(ctx, "package.json");
	const deps = packageDeps(pkg);
	const scripts = packageScripts(pkg);
	if (
		depsHasAny(deps, ["knip", "unimported", "ts-prune"]) ||
		scriptMatches(scripts, /knip|unimported|ts-prune/i)
	) {
		return pass("orphan-module analyzer configured (knip / unimported / ts-prune)");
	}
	for (const rel of ["knip.json", "knip.jsonc", "knip.config.ts", "knip.config.js", ".knip.json"]) {
		if ((await ctx.readFile(rel)) !== null) return pass(`knip configured in '${rel}'`);
	}
	if (pkg?.knip !== undefined) return pass("knip configured via package.json `knip` key");
	return fail("no orphan/unreachable-module analyzer configured (knip / unimported)");
};

/** `explicit_any_detection` (A/L3, S): `any` is a hard lint error. */
export const explicitAnyDetection: Detector = async (ctx) => {
	const biome = await findBiomeConfig(ctx);
	if (biome !== null && biomeLinterEnabled(biome.config)) {
		const level = biomeRuleLevel(biome.config, "suspicious", "noExplicitAny");
		if (level === "error") return pass("Biome `noExplicitAny` is a hard error");
		if (level !== null && level !== "off")
			return fail(`Biome \`noExplicitAny\` is '${level}', not a hard error`);
	}
	const eslint = await findEslintConfig(ctx);
	if (eslint !== null) {
		const text = (await ctx.readFile(eslint)) ?? "";
		if (/no-explicit-any["'\s]*[:,]\s*["']?(error|2)/i.test(text)) {
			return pass("ESLint `@typescript-eslint/no-explicit-any` is a hard error");
		}
		if (/no-explicit-any/i.test(text))
			return fail("ESLint `no-explicit-any` configured but not as an error");
	}
	return fail(
		"`any` is not enforced as a hard error (Biome noExplicitAny / ESLint no-explicit-any)",
	);
};

/** Compiler flags counted as "beyond baseline strict" for `strictest_type_checking`. */
const BEYOND_BASELINE = [
	"noUncheckedIndexedAccess",
	"exactOptionalPropertyTypes",
	"noImplicitOverride",
	"noPropertyAccessFromIndexSignature",
	"noImplicitReturns",
	"noFallthroughCasesInSwitch",
	"noUnusedLocals",
	"noUnusedParameters",
] as const;

/** `strictest_type_checking` (A/L4, S): strict flags beyond the baseline `strict`. */
export const strictestTypeChecking: Detector = async (ctx) => {
	const tsconfig = await loadTsConfig(ctx);
	if (tsconfig === null)
		return fail("no tsconfig.json; cannot enable beyond-baseline strict flags");
	const co = tsconfig.compilerOptions;
	const extras = BEYOND_BASELINE.filter((name) => flag(co, name));
	if (flag(co, "strict") && (flag(co, "noUncheckedIndexedAccess") || extras.length >= 2)) {
		return pass(`beyond-baseline strict flags set: ${extras.join(", ")}`);
	}
	if (extras.length === 0 && tsconfig.extendsUnresolved) {
		return noDetector("strict flags may come from an unresolved `extends` preset; cannot confirm");
	}
	return fail("no beyond-baseline strict flags (noUncheckedIndexedAccess etc.) configured");
};

/** Match a default export in TypeScript source. */
const DEFAULT_EXPORT_RE = /^\s*export\s+default\b|\bexport\s*\{[^}]*\bas\s+default\b[^}]*\}/m;
/** Match a wildcard re-export (`export *`). */
const WILDCARD_REEXPORT_RE = /^\s*export\s+\*\s+(?:as\s+\w+\s+)?from\b/m;

/** `greppable_exports` (A/L3, S): named exports only — no default exports. */
export const greppableExports: Detector = async (ctx) => {
	const files = await tsSources(ctx);
	if (files.length === 0)
		return notApplicable("no TypeScript sources to analyze for default exports");
	const offenders: string[] = [];
	for (const file of files) {
		const text = await ctx.readFile(file);
		if (text !== null && DEFAULT_EXPORT_RE.test(text)) offenders.push(file);
	}
	if (offenders.length === 0) return pass(`no default exports across ${files.length} module(s)`);
	return fail(
		`default export(s) found in ${offenders.length} file(s): ${offenders.slice(0, 3).join(", ")}`,
	);
};

/** `barrel_file_reexport_detection` (A/L4, S): no `export *` wildcard barrels. */
export const barrelFileReexportDetection: Detector = async (ctx) => {
	const files = await tsSources(ctx);
	if (files.length === 0)
		return notApplicable("no TypeScript sources to analyze for wildcard barrels");
	const offenders: string[] = [];
	for (const file of files) {
		const text = await ctx.readFile(file);
		if (text !== null && WILDCARD_REEXPORT_RE.test(text)) offenders.push(file);
	}
	if (offenders.length === 0)
		return pass(`no \`export *\` wildcard barrels across ${files.length} module(s)`);
	return fail(
		`wildcard re-export(s) in ${offenders.length} file(s): ${offenders.slice(0, 3).join(", ")}`,
	);
};

/** `mutation_testing` (A/L5, S): a mutation-testing harness (StrykerJS). */
export const mutationTesting: Detector = async (ctx) => {
	const pkg = await readJson(ctx, "package.json");
	const deps = packageDeps(pkg);
	if (
		[...deps].some((d) => d.startsWith("@stryker-mutator/")) ||
		scriptMatches(packageScripts(pkg), /stryker/i)
	) {
		return pass("mutation testing configured (StrykerJS)");
	}
	for (const rel of [
		"stryker.conf.json",
		"stryker.conf.js",
		"stryker.conf.mjs",
		"stryker.conf.cjs",
		".stryker.conf.json",
	]) {
		if ((await ctx.readFile(rel)) !== null) return pass(`StrykerJS configured in '${rel}'`);
	}
	return notApplicable("no mutation-testing harness configured (skippable → N/A)");
};
