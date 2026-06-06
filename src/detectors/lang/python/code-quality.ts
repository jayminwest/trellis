/**
 * Python adapter — §5.2 Code Quality detectors (SPEC §8.3 table).
 *
 * The seam from SPEC §5.2: the rubric never names a tool; this adapter binds the
 * Python-conventional ones (ruff / mypy / black / vulture / jscpd / deptry /
 * radon). Two disciplines run throughout, mirroring the other adapters: a
 * configured-but-unavailable tool degrades to `no-detector` (we owe the repo a
 * real check), and a concept that genuinely exists for Python is graded pass/fail.
 * Unlike Swift, `unused_dependencies_detection` is **not** N/A here — the §8.3
 * table binds it to deptry — so every criterion in this module is gradable.
 * Detection is config-first: presence of a tool's config (a `[tool.X]` table, an
 * INI section, a dedicated dotfile, or a mention in build glue) is the signal, so
 * the audit needs no Python toolchain on CI except for `type_check`, which — like
 * Swift's `swift build` — runs the tool and degrades honestly when it cannot.
 */
import { SPAWN_FAILURE_EXIT } from "../../context.ts";
import { type Detector, fail, noDetector, pass } from "../../types.ts";
import { gatherMypyConfigText, locateTool } from "./util.ts";

/** `lint_config` (A/L1): a linter configured with real rules (ruff / flake8 / pylint). */
export const lintConfig: Detector = async (ctx) => {
	const where = await locateTool(ctx, {
		files: ["ruff.toml", ".ruff.toml", ".flake8", ".pylintrc", "pylintrc"],
		configRe: /\[tool\.ruff\b|\[tool\.flake8\]|\[flake8\]|\[tool\.pylint|\[pylint\b/,
		mention: /\b(ruff|flake8|pylint)\b/,
	});
	return where !== null
		? pass(`a linter is configured (${where})`)
		: fail("no linter configured (ruff / flake8 / pylint)");
};

/** Where mypy is configured, or `null`. */
async function findMypyConfig(
	ctx: import("../../types.ts").DetectionContext,
): Promise<string | null> {
	return locateTool(ctx, {
		files: ["mypy.ini", ".mypy.ini"],
		configRe: /\[tool\.mypy\]|\[mypy\]/,
		mention: /\bmypy\b/,
	});
}

/** `type_check` (A/L1, GATE): mypy configured AND clean (runs `mypy .`). */
export const typeCheck: Detector = async (ctx) => {
	const where = await findMypyConfig(ctx);
	if (where === null) return fail("no type checker configured (mypy)");
	const result = await ctx.run(["mypy", "."]);
	if (result.timedOut) return noDetector("`mypy` timed out before completing");
	if (result.exitCode === SPAWN_FAILURE_EXIT) {
		return noDetector(`mypy configured (${where}) but could not run (toolchain unavailable)`);
	}
	return result.exitCode === 0
		? pass(`mypy type-checks clean (${where})`)
		: fail(`mypy reported type errors (exit ${result.exitCode})`);
};

/** `strict_typing` (A/L2, S): mypy run in `--strict` mode (or `strict = true`). */
export const strictTyping: Detector = async (ctx) => {
	const blob = await gatherMypyConfigText(ctx);
	if (/strict\s*=\s*true/i.test(blob)) {
		return pass("mypy `strict` mode is enabled in configuration");
	}
	if (/\bmypy\b[^\n]*--strict\b|--strict\b[^\n]*\bmypy\b/i.test(blob)) {
		return pass("mypy is invoked with `--strict` in build tooling");
	}
	return fail("strict type-checking is not enabled (no mypy `strict = true` / `--strict`)");
};

/** `formatter` (A/L1): an autoformatter configured (ruff format / black). */
export const formatter: Detector = async (ctx) => {
	const where = await locateTool(ctx, {
		configRe: /\[tool\.black\]|\[tool\.ruff(\.format)?\]|\[tool\.yapf\]|\[tool\.autopep8\]/,
		mention: /\bblack\b|ruff\s+format|\byapf\b|\bautopep8\b/,
	});
	return where !== null
		? pass(`an autoformatter is configured (${where})`)
		: fail("no autoformatter configured (ruff format / black)");
};

/** `naming_consistency` (A/L3): naming conventions enforced (pylint / ruff pep8-naming). */
export const namingConsistency: Detector = async (ctx) => {
	// pylint enforces naming (C01xx) out of the box, so any pylint config counts.
	const pylint = await locateTool(ctx, {
		files: [".pylintrc", "pylintrc"],
		configRe: /\[tool\.pylint|\[pylint\b/,
		mention: /\bpylint\b/,
	});
	if (pylint !== null) return pass(`pylint enforces naming conventions (${pylint})`);
	// ruff: pep8-naming (the `N` rule family) must be explicitly selected — it is
	// not in ruff's default rule set, so a bare ruff config does not prove naming.
	const ruffNaming = await locateTool(ctx, {
		configRe: /(?:select|extend-select)\b[\s\S]{0,400}?["']N(?:\d|["'])/,
		mention: /pep8-naming/,
	});
	if (ruffNaming !== null) return pass(`ruff selects pep8-naming rules (${ruffNaming})`);
	return fail("no naming-convention enforcement (pylint / ruff pep8-naming `N` rules)");
};

/** `dead_code_detection` (A/L3): an unused-code analyzer (vulture). */
export const deadCodeDetection: Detector = async (ctx) => {
	const where = await locateTool(ctx, {
		configRe: /\[tool\.vulture\]/,
		mention: /\bvulture\b/,
	});
	return where !== null
		? pass(`a dead-code analyzer is configured (${where})`)
		: fail("no dead-code/unused-code analyzer configured (vulture)");
};

/** `duplicate_code_detection` (A/L3): a copy-paste detector (jscpd / pylint duplicate-code). */
export const duplicateCodeDetection: Detector = async (ctx) => {
	const where = await locateTool(ctx, {
		files: [".jscpd.json", "jscpd.json", ".jscpd.config.json", ".pylintrc", "pylintrc"],
		configRe: /\[tool\.jscpd\]|\[tool\.pylint|\[pylint\b|min-similarity-lines/,
		mention: /\bjscpd\b|\bsymilar\b|duplicate-code/,
	});
	return where !== null
		? pass(`a copy-paste detector is configured (${where})`)
		: fail("no copy-paste/duplicate-code detector configured (jscpd / pylint duplicate-code)");
};

/** `unused_dependencies_detection` (A/L3): an unused-dependency analyzer (deptry). */
export const unusedDependenciesDetection: Detector = async (ctx) => {
	const where = await locateTool(ctx, {
		configRe: /\[tool\.deptry\]/,
		mention: /\bdeptry\b|\bfawltydeps\b|pip-extra-reqs|pip-missing-reqs/,
	});
	return where !== null
		? pass(`an unused-dependency analyzer is configured (${where})`)
		: fail("no unused-dependency analyzer configured (deptry)");
};

/** `cyclomatic_complexity` (A/L5): per-function complexity capped (radon / ruff C901). */
export const cyclomaticComplexity: Detector = async (ctx) => {
	const where = await locateTool(ctx, {
		configRe: /\[tool\.ruff\.lint\.mccabe\]|\[tool\.ruff\.mccabe\]|max[-_]complexity|\bC901\b/,
		mention: /\bradon\b|\bxenon\b|max[-_]complexity|\bC901\b/,
	});
	return where !== null
		? pass(`per-function complexity is capped (${where})`)
		: fail("no per-function complexity cap (radon / ruff C901 / max-complexity)");
};
