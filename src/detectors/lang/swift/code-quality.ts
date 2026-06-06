/**
 * Swift adapter — §5.2 Code Quality detectors (SPEC §8.3 table).
 *
 * The seam from SPEC §5.2: the rubric never names a tool; this adapter binds the
 * Swift-conventional ones (SwiftLint / `swift build` / swift-format / periphery /
 * jscpd). Two disciplines run throughout, mirroring the TypeScript adapter: a
 * configured-but-unavailable tool degrades to `no-detector` (we owe the repo a
 * real check), and a concept that genuinely exists for Swift is graded pass/fail.
 * The one cross-language gap here — `unused_dependencies_detection`, which the
 * §8.3 table marks "— (N/A)" for Swift — resolves to `not-applicable` with a
 * rationale naming the gap (SPEC §8.3: "a criterion with no analogue in a
 * language resolves to not-applicable"), never a silent skip.
 */
import { SPAWN_FAILURE_EXIT } from "../../context.ts";
import { type Detector, fail, noDetector, notApplicable, pass } from "../../types.ts";
import {
	findSwiftlintConfig,
	firstPresent,
	gatherToolingText,
	readManifest,
	swiftlintDefaultRuleEnabled,
	toolingMentions,
} from "./util.ts";

/** `lint_config` (A/L1): a linter configured with real rules (SwiftLint). */
export const lintConfig: Detector = async (ctx) => {
	const swiftlint = await findSwiftlintConfig(ctx);
	if (swiftlint !== null) return pass(`SwiftLint configured in '${swiftlint.path}'`);
	if (toolingMentions(await gatherToolingText(ctx), /\bswiftlint\b/i)) {
		return pass("SwiftLint wired via build tooling (ships default rules without a config file)");
	}
	return fail("no linter configured (no .swiftlint.yml or SwiftLint in build tooling)");
};

/** `type_check` (A/L1, GATE): a SwiftPM build configured AND clean (`swift build`). */
export const typeCheck: Detector = async (ctx) => {
	if ((await readManifest(ctx)) === null) {
		return fail("no Package.swift; SwiftPM type-checking is not configured");
	}
	const argv = ["swift", "build"];
	const result = await ctx.run(argv);
	if (result.timedOut) return noDetector("`swift build` timed out before completing");
	if (result.exitCode === SPAWN_FAILURE_EXIT) {
		return noDetector(
			"Package.swift present but `swift build` could not run (toolchain unavailable)",
		);
	}
	return result.exitCode === 0
		? pass("`swift build` type-checks clean")
		: fail(`\`swift build\` reported errors (exit ${result.exitCode})`);
};

/** Package.swift patterns that turn compiler warnings into hard errors. */
const WARNINGS_AS_ERRORS_RE =
	/-warnings-as-errors|treatAllWarnings\s*\(\s*as:\s*\.error|treatWarningsAsErrors/;

/** `strict_typing` (A/L2, S): warnings-as-errors enabled for the SwiftPM build. */
export const strictTyping: Detector = async (ctx) => {
	const manifest = await readManifest(ctx);
	if (manifest === null) return fail("no Package.swift; cannot enable warnings-as-errors");
	if (WARNINGS_AS_ERRORS_RE.test(manifest)) {
		return pass("Package.swift treats compiler warnings as errors");
	}
	if (toolingMentions(await gatherToolingText(ctx), /-warnings-as-errors/)) {
		return pass("build tooling passes `-warnings-as-errors` to the Swift compiler");
	}
	return fail("warnings are not treated as errors (no `-warnings-as-errors` / treatAllWarnings)");
};

/** swift-format / SwiftFormat config filenames. */
const FORMATTER_CONFIGS = [".swift-format", ".swift-format.json", ".swiftformat"] as const;

/** `formatter` (A/L1): an autoformatter configured (swift-format / SwiftFormat). */
export const formatter: Detector = async (ctx) => {
	const cfg = await firstPresent(ctx, FORMATTER_CONFIGS);
	if (cfg !== null) return pass(`autoformatter configured in '${cfg}'`);
	if (toolingMentions(await gatherToolingText(ctx), /\bswift-?format\b/i)) {
		return pass("an autoformatter (swift-format / SwiftFormat) is wired via build tooling");
	}
	return fail("no autoformatter configured (swift-format / SwiftFormat)");
};

/** `naming_consistency` (A/L3): naming conventions enforced (SwiftLint naming rules). */
export const namingConsistency: Detector = async (ctx) => {
	const swiftlint = await findSwiftlintConfig(ctx);
	if (swiftlint !== null) {
		const idName = swiftlintDefaultRuleEnabled(swiftlint.config, "identifier_name");
		const typeName = swiftlintDefaultRuleEnabled(swiftlint.config, "type_name");
		if (idName || typeName) {
			return pass(`SwiftLint enforces naming rules in '${swiftlint.path}'`);
		}
		return fail(`SwiftLint configured in '${swiftlint.path}' but naming rules are disabled`);
	}
	if (toolingMentions(await gatherToolingText(ctx), /\bswiftlint\b/i)) {
		return pass("SwiftLint wired via build tooling (default identifier_name/type_name rules)");
	}
	return fail("no naming-convention enforcement (SwiftLint identifier_name/type_name)");
};

/** `dead_code_detection` (A/L3): an unused-declaration analyzer (periphery). */
export const deadCodeDetection: Detector = async (ctx) => {
	const cfg = await firstPresent(ctx, [".periphery.yml", ".periphery.yaml", "periphery.yml"]);
	if (cfg !== null) return pass(`periphery configured in '${cfg}'`);
	if (toolingMentions(await gatherToolingText(ctx), /\bperiphery\b/i)) {
		return pass("periphery (dead-code analyzer) wired via build tooling");
	}
	return fail("no dead-code/unused-declaration analyzer configured (periphery)");
};

/** `duplicate_code_detection` (A/L3): a copy-paste detector (jscpd). */
export const duplicateCodeDetection: Detector = async (ctx) => {
	const cfg = await firstPresent(ctx, [".jscpd.json", "jscpd.json", ".jscpd.config.json"]);
	if (cfg !== null) return pass(`jscpd configured in '${cfg}'`);
	if (toolingMentions(await gatherToolingText(ctx), /\bjscpd\b/i)) {
		return pass("jscpd (copy-paste detector) wired via build tooling");
	}
	return fail("no copy-paste/duplicate-code detector configured (jscpd)");
};

/**
 * `unused_dependencies_detection` (A/L3): no Swift analogue. SwiftPM lists
 * dependencies in Package.swift, but there is no mainstream tool that flags
 * unused ones — the §8.3 table marks this "— (N/A)" for Swift, so it resolves to
 * `not-applicable` (excluded from coverage), not a fail.
 */
export const unusedDependenciesDetection: Detector = async () =>
	notApplicable(
		"no Swift analogue: no mainstream tool flags unused SwiftPM dependencies (SPEC §8.3 N/A)",
	);

/** `cyclomatic_complexity` (A/L5): per-function complexity capped (SwiftLint complexity rules). */
export const cyclomaticComplexity: Detector = async (ctx) => {
	const swiftlint = await findSwiftlintConfig(ctx);
	if (swiftlint !== null) {
		const cyclo = swiftlintDefaultRuleEnabled(swiftlint.config, "cyclomatic_complexity");
		const bodyLen = swiftlintDefaultRuleEnabled(swiftlint.config, "function_body_length");
		if (cyclo) return pass(`SwiftLint caps cyclomatic complexity in '${swiftlint.path}'`);
		if (bodyLen) return pass(`SwiftLint caps function body length in '${swiftlint.path}'`);
		return fail(`SwiftLint configured in '${swiftlint.path}' but complexity rules are disabled`);
	}
	if (toolingMentions(await gatherToolingText(ctx), /\bswiftlint\b/i)) {
		return pass("SwiftLint wired via build tooling (default cyclomatic_complexity rule)");
	}
	return fail("no per-function complexity cap (SwiftLint cyclomatic_complexity)");
};
