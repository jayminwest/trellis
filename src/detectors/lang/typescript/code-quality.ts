/**
 * TypeScript adapter — §5.2 Code Quality detectors (SPEC §8.3 table).
 *
 * The seam from SPEC §5.2: the rubric never names a tool; this adapter binds the
 * TypeScript-conventional ones (Biome / tsc / knip / jscpd). Two disciplines run
 * throughout: a configured-but-unavailable tool degrades to `no-detector` (we
 * owe the repo a real check), and a concept that genuinely exists for TypeScript
 * is graded pass/fail — never `not-applicable` (that bucket is for the Swift /
 * Python adapters where the analogue is absent). Non-skippable criteria fail on
 * absent config (SPEC §3.2: they can never be N/A); the skippable *optional
 * tooling* ones (`code_modularization`) map honest absence to `not-applicable`.
 */

import { packageDeps, packageScripts, readJson } from "../../common/util.ts";
import { SPAWN_FAILURE_EXIT } from "../../context.ts";
import { type Detector, fail, noDetector, notApplicable, pass } from "../../types.ts";
import {
	biomeLinterEnabled,
	biomeRecommended,
	biomeRuleLevel,
	depsHasAny,
	findBiomeConfig,
	findEslintConfig,
	flag,
	loadTsConfig,
	scriptMatches,
} from "./util.ts";

/** `lint_config` (A/L1): a linter configured with real rules (Biome or ESLint). */
export const lintConfig: Detector = async (ctx) => {
	const biome = await findBiomeConfig(ctx);
	if (biome !== null && biomeLinterEnabled(biome.config)) {
		return pass(`Biome linter configured in '${biome.path}'`);
	}
	const eslint = await findEslintConfig(ctx);
	if (eslint !== null) return pass(`ESLint configured in '${eslint}'`);
	if (depsHasAny(packageDeps(await readJson(ctx, "package.json")), ["eslint", "@biomejs/biome"])) {
		return pass("a linter (ESLint/Biome) is a declared dependency");
	}
	return fail("no linter configured (no Biome/ESLint config or dependency)");
};

/** Names/commands that indicate a configured type-check step. */
const TYPECHECK_RE = /typecheck|type-check|check:types|tsc\b/i;

/** `type_check` (A/L1, GATE): a type-checker configured AND clean (`tsc --noEmit`). */
export const typeCheck: Detector = async (ctx) => {
	const tsconfig = await loadTsConfig(ctx);
	if (tsconfig === null)
		return fail("no tsconfig.json; TypeScript type-checking is not configured");
	const scripts = packageScripts(await readJson(ctx, "package.json"));
	const scriptName = Object.keys(scripts).find(
		(k) => TYPECHECK_RE.test(k) || TYPECHECK_RE.test(scripts[k] ?? ""),
	);
	const argv = scriptName !== undefined ? ["bun", "run", scriptName] : ["tsc", "--noEmit"];
	const result = await ctx.run(argv);
	if (result.timedOut) return noDetector("type-check command timed out before completing");
	if (result.exitCode === SPAWN_FAILURE_EXIT) {
		return noDetector("tsconfig present but the type-checker could not be run (tool unavailable)");
	}
	return result.exitCode === 0
		? pass(`type-checker clean via \`${argv.join(" ")}\``)
		: fail(`type-checker reported errors via \`${argv.join(" ")}\` (exit ${result.exitCode})`);
};

/** `formatter` (A/L1): an autoformatter configured (Biome / Prettier / dprint). */
export const formatter: Detector = async (ctx) => {
	const biome = await findBiomeConfig(ctx);
	if (biome !== null) {
		const fmt = biome.config.formatter;
		const enabled =
			typeof fmt !== "object" || fmt === null || (fmt as Record<string, unknown>).enabled !== false;
		if (enabled) return pass(`Biome formatter configured in '${biome.path}'`);
	}
	for (const rel of [
		".prettierrc",
		".prettierrc.json",
		".prettierrc.js",
		".prettierrc.cjs",
		".prettierrc.yaml",
		".prettierrc.yml",
		"prettier.config.js",
		"prettier.config.cjs",
		"dprint.json",
		".dprint.json",
	]) {
		if ((await ctx.readFile(rel)) !== null) return pass(`autoformatter configured in '${rel}'`);
	}
	const pkg = await readJson(ctx, "package.json");
	if (pkg?.prettier !== undefined)
		return pass("Prettier configured via package.json `prettier` key");
	if (depsHasAny(packageDeps(pkg), ["prettier", "dprint", "@biomejs/biome"])) {
		return pass("an autoformatter (Prettier/dprint/Biome) is a declared dependency");
	}
	return fail("no autoformatter configured (Biome/Prettier/dprint)");
};

/** `strict_typing` (A/L2): TypeScript `strict` mode (no implicit any). */
export const strictTyping: Detector = async (ctx) => {
	const tsconfig = await loadTsConfig(ctx);
	if (tsconfig === null) return fail("no tsconfig.json; cannot enable strict typing");
	const co = tsconfig.compilerOptions;
	if (flag(co, "strict") || (flag(co, "noImplicitAny") && flag(co, "strictNullChecks"))) {
		return pass(`tsconfig enables strict typing ('${tsconfig.path}')`);
	}
	if (co.strict === undefined && tsconfig.extendsUnresolved) {
		return noDetector("strictness may come from an unresolved `extends` preset; cannot confirm");
	}
	return fail("tsconfig does not enable `strict` (nor noImplicitAny + strictNullChecks)");
};

/** `naming_consistency` (A/L3): naming conventions enforced (Biome filenaming/naming or ESLint). */
export const namingConsistency: Detector = async (ctx) => {
	const biome = await findBiomeConfig(ctx);
	if (biome !== null && biomeLinterEnabled(biome.config)) {
		const fileLevel = biomeRuleLevel(biome.config, "style", "useFilenamingConvention");
		const nameLevel = biomeRuleLevel(biome.config, "style", "useNamingConvention");
		if (fileLevel !== null && fileLevel !== "off")
			return pass("Biome enforces `useFilenamingConvention`");
		if (nameLevel !== null && nameLevel !== "off")
			return pass("Biome enforces `useNamingConvention`");
		if (biomeRecommended(biome.config))
			return pass("Biome `recommended` enforces `useNamingConvention`");
	}
	const eslint = await findEslintConfig(ctx);
	if (eslint !== null) {
		const text = (await ctx.readFile(eslint)) ?? "";
		if (/naming-convention|unicorn\/filename-case|filename/i.test(text)) {
			return pass(`ESLint config '${eslint}' enforces a naming/filename rule`);
		}
	}
	return fail("no naming-convention enforcement (Biome useNaming/Filenaming or ESLint rule)");
};

/** `dead_code_detection` (A/L3): an unused-export/unreachable analyzer (knip / ts-prune). */
export const deadCodeDetection: Detector = async (ctx) => {
	const pkg = await readJson(ctx, "package.json");
	const deps = packageDeps(pkg);
	const scripts = packageScripts(pkg);
	if (
		depsHasAny(deps, ["knip", "ts-prune", "ts-unused-exports"]) ||
		scriptMatches(scripts, /knip|ts-prune|ts-unused/i)
	) {
		return pass("dead-code analyzer configured (knip / ts-prune)");
	}
	for (const rel of ["knip.json", "knip.jsonc", "knip.config.ts", "knip.config.js", ".knip.json"]) {
		if ((await ctx.readFile(rel)) !== null) return pass(`knip configured in '${rel}'`);
	}
	if (pkg?.knip !== undefined) return pass("knip configured via package.json `knip` key");
	return fail("no dead-code/unused-export analyzer configured (knip / ts-prune)");
};

/** `duplicate_code_detection` (A/L3): a copy-paste detector under a threshold (jscpd). */
export const duplicateCodeDetection: Detector = async (ctx) => {
	const pkg = await readJson(ctx, "package.json");
	if (
		depsHasAny(packageDeps(pkg), ["jscpd", "@jscpd/core"]) ||
		scriptMatches(packageScripts(pkg), /jscpd/i)
	) {
		return pass("copy-paste detector configured (jscpd)");
	}
	for (const rel of [".jscpd.json", "jscpd.json", ".jscpd.config.json"]) {
		if ((await ctx.readFile(rel)) !== null) return pass(`jscpd configured in '${rel}'`);
	}
	if (pkg?.jscpd !== undefined) return pass("jscpd configured via package.json `jscpd` key");
	return fail("no copy-paste/duplicate-code detector configured (jscpd)");
};

/** `unused_dependencies_detection` (A/L3): unused declared deps flagged (knip / depcheck). */
export const unusedDependenciesDetection: Detector = async (ctx) => {
	const pkg = await readJson(ctx, "package.json");
	const deps = packageDeps(pkg);
	const scripts = packageScripts(pkg);
	if (depsHasAny(deps, ["knip", "depcheck"]) || scriptMatches(scripts, /knip|depcheck/i)) {
		return pass("unused-dependency analyzer configured (knip / depcheck)");
	}
	for (const rel of ["knip.json", "knip.jsonc", "knip.config.ts", "knip.config.js", ".knip.json"]) {
		if ((await ctx.readFile(rel)) !== null) return pass(`knip configured in '${rel}'`);
	}
	if (pkg?.knip !== undefined) return pass("knip configured via package.json `knip` key");
	return fail("no unused-dependency analyzer configured (knip / depcheck)");
};

/** `code_modularization` (A/L4, S): an import-direction/layering analyzer. */
export const codeModularization: Detector = async (ctx) => {
	const pkg = await readJson(ctx, "package.json");
	const deps = packageDeps(pkg);
	if (
		depsHasAny(deps, ["dependency-cruiser", "eslint-plugin-boundaries", "eslint-plugin-import"])
	) {
		return pass("import-direction analyzer configured (dependency-cruiser / eslint boundaries)");
	}
	for (const rel of [
		".dependency-cruiser.js",
		".dependency-cruiser.cjs",
		".dependency-cruiser.json",
		".dependency-cruiser.mjs",
	]) {
		if ((await ctx.readFile(rel)) !== null)
			return pass(`dependency-cruiser configured in '${rel}'`);
	}
	const eslint = await findEslintConfig(ctx);
	if (eslint !== null) {
		const text = (await ctx.readFile(eslint)) ?? "";
		if (/no-restricted-paths|boundaries\//i.test(text)) {
			return pass(`ESLint config '${eslint}' enforces import-direction rules`);
		}
	}
	return notApplicable("no import-direction analyzer configured (skippable → N/A)");
};

/** `cyclomatic_complexity` (A/L5): per-function complexity capped (Biome / ESLint). */
export const cyclomaticComplexity: Detector = async (ctx) => {
	const biome = await findBiomeConfig(ctx);
	if (biome !== null && biomeLinterEnabled(biome.config)) {
		const cog = biomeRuleLevel(biome.config, "complexity", "noExcessiveCognitiveComplexity");
		const lines = biomeRuleLevel(biome.config, "complexity", "noExcessiveLinesPerFunction");
		if (cog !== null && cog !== "off") return pass("Biome caps cognitive complexity per function");
		if (lines !== null && lines !== "off") return pass("Biome caps lines per function");
	}
	const eslint = await findEslintConfig(ctx);
	if (eslint !== null) {
		const text = (await ctx.readFile(eslint)) ?? "";
		if (/['"]complexity['"]|sonarjs\/cognitive-complexity|max-lines-per-function/i.test(text)) {
			return pass(`ESLint config '${eslint}' caps per-function complexity`);
		}
	}
	return fail("no per-function complexity cap (Biome complexity rules / ESLint `complexity`)");
};
