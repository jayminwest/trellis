/**
 * Python adapter — §5.9 Locality & Contracts detectors (import-graph + cross-language N/A).
 *
 * Three of the §5.9 criteria are TypeScript stack-concepts the §8.3 table marks
 * N/A for Python — `greppable_exports`, `barrel_file_reexport_detection`,
 * `explicit_any_detection` — and `strictest_type_checking` has no Python tier
 * beyond `strict_typing`'s `mypy --strict`; all four return `not-applicable` with a
 * rationale naming the gap (SPEC §8.3), never a silent skip and never a fail.
 * `import_cycle_detection` and `orphan_module_detection` DO have Python analogues
 * (import-linter / grimp / pydeps build a real module graph), so they are graded
 * config-first. `mutation_testing` passes when mutmut is configured and otherwise
 * resolves to `not-applicable` (it is skippable optional tooling).
 */
import { type Detector, fail, notApplicable, pass } from "../../types.ts";
import { locateTool } from "./util.ts";

/** `import_cycle_detection` (A/L4, GATE): an acyclic-import enforcer (import-linter / grimp / pydeps). */
export const importCycleDetection: Detector = async (ctx) => {
	const where = await locateTool(ctx, {
		files: [".importlinter"],
		configRe: /\[tool\.importlinter\]|\[importlinter\]|\[import-linter\]/,
		mention: /\bimport-linter\b|\bimportlinter\b|\bgrimp\b|\bpydeps\b/,
	});
	return where !== null
		? pass(`import-cycle detection is configured (${where})`)
		: fail("no import-cycle detector configured (import-linter / grimp / pydeps)");
};

/** `orphan_module_detection` (A/L3): an unreachable-module analyzer (pydeps / tach). */
export const orphanModuleDetection: Detector = async (ctx) => {
	const where = await locateTool(ctx, {
		configRe: /\[tool\.pydeps\]|\[tool\.tach\]/,
		mention: /\bpydeps\b|\btach\b/,
	});
	return where !== null
		? pass(`an unreachable-module analyzer is configured (${where})`)
		: fail("no orphan/unreachable-module analyzer configured (pydeps / tach)");
};

/**
 * `explicit_any_detection` (A/L3, S): N/A for Python per the SPEC §8.3 table,
 * which lists this alongside the TypeScript-specific export criteria. Python's
 * gradual typing has no hard-error `any`-escape-hatch convention; the strictness
 * tier it does have (mypy `--strict`) is already graded by `strict_typing`.
 */
export const explicitAnyDetection: Detector = async () =>
	notApplicable(
		"no Python analogue (SPEC §8.3 N/A): no hard-error `any`-escape-hatch convention; mypy --strict is graded by strict_typing",
	);

/**
 * `greppable_exports` (A/L3, S): no Python analogue. Python has no export
 * statements; a module's public surface is governed by `__all__` and the
 * leading-underscore convention, not by named/default exports to grep for.
 */
export const greppableExports: Detector = async () =>
	notApplicable(
		"no Python analogue: Python uses `__all__` / underscore convention, not named/default exports",
	);

/**
 * `barrel_file_reexport_detection` (A/L4, S): no Python analogue. Python has no
 * `export *` / barrel-file re-export construct; an `__init__.py` re-imports
 * symbols explicitly, so wildcard-reexport barrels cannot exist.
 */
export const barrelFileReexportDetection: Detector = async () =>
	notApplicable("no Python analogue: Python has no `export *` / barrel-file re-export construct");

/**
 * `strictest_type_checking` (A/L4, S): N/A for Python. `mypy --strict` is the
 * strictest standard tier and is already graded by `strict_typing`; there is no
 * beyond-strict standard preset (unlike TS's noUncheckedIndexedAccess et al.).
 */
export const strictestTypeChecking: Detector = async () =>
	notApplicable(
		"no Python analogue: mypy --strict is the strictest standard tier (graded by strict_typing); no beyond-strict preset",
	);

/** `mutation_testing` (A/L5, S): a mutation-testing harness (mutmut / cosmic-ray). */
export const mutationTesting: Detector = async (ctx) => {
	const where = await locateTool(ctx, {
		configRe: /\[mutmut\]|\[tool\.mutmut\]|\[cosmic-ray\]|\[tool\.cosmic-ray\]/,
		mention: /\bmutmut\b|\bcosmic-ray\b/,
	});
	return where !== null
		? pass(`mutation testing is configured (${where})`)
		: notApplicable("no mutation-testing harness configured (mutmut); skippable → N/A");
};
