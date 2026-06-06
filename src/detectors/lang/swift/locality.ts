/**
 * Swift adapter — §5.9 Locality & Contracts detectors (cross-language N/A + muter).
 *
 * Four of the §5.9 criteria are TypeScript stack-concepts with no Swift analogue,
 * so — per SPEC §8.3 ("a criterion with no analogue in a language resolves to
 * not-applicable") — they return `not-applicable` with a rationale naming the
 * exact language gap, never a silent skip and never a fail. `import_cycle_detection`
 * is likewise N/A: SwiftPM rejects target dependency cycles at build time and the
 * §8.3 table binds no file-level cycle tool for Swift. `mutation_testing` is the
 * one gradable criterion here — it passes when a muter harness is configured and
 * otherwise resolves to `not-applicable` (it is skippable optional tooling).
 */
import { type Detector, notApplicable, pass } from "../../types.ts";
import { firstPresent, gatherToolingText, toolingMentions } from "./util.ts";

/**
 * `explicit_any_detection` (A/L3, S): no Swift analogue. Swift has no `any`-style
 * unchecked escape hatch — `Any`/`AnyObject` are explicit, type-checked types,
 * not an implicit untyped bailout the way TypeScript's `any` is.
 */
export const explicitAnyDetection: Detector = async () =>
	notApplicable(
		"no Swift analogue: Swift has no `any`-style unchecked escape hatch (Any is typed)",
	);

/**
 * `greppable_exports` (A/L3, S): no Swift analogue. Swift has no default-export
 * construct; visible API is governed by access-control modifiers (public/internal/
 * private), not export statements, so there is nothing to grep for.
 */
export const greppableExports: Detector = async () =>
	notApplicable(
		"no Swift analogue: Swift uses access-control modifiers, not default/named exports",
	);

/**
 * `barrel_file_reexport_detection` (A/L4, S): no Swift analogue. Swift has no
 * `export *` / barrel-file re-export construct; modules expose their public
 * symbols directly via `import`, so wildcard re-export barrels cannot exist.
 */
export const barrelFileReexportDetection: Detector = async () =>
	notApplicable("no Swift analogue: Swift has no `export *` / barrel-file re-export construct");

/**
 * `import_cycle_detection` (A/L4, GATE): N/A for Swift. SwiftPM forbids target
 * dependency cycles at build time, and the §8.3 table binds no file-level
 * import-cycle tool for Swift, so there is no analogue detector to run.
 */
export const importCycleDetection: Detector = async () =>
	notApplicable(
		"no Swift analogue: SwiftPM rejects target dependency cycles at build; no file-level tool bound",
	);

/** muter config filenames (mutation-testing harness for Swift). */
const MUTER_CONFIGS = ["muter.conf.yml", "muter.conf.yaml", "muter.conf.json", ".muter.conf.yml"];

/** `mutation_testing` (A/L5, S): a mutation-testing harness (muter). */
export const mutationTesting: Detector = async (ctx) => {
	const cfg = await firstPresent(ctx, MUTER_CONFIGS);
	if (cfg !== null) return pass(`mutation testing configured (muter) in '${cfg}'`);
	if (toolingMentions(await gatherToolingText(ctx), /\bmuter\b/i)) {
		return pass("mutation testing (muter) wired via build tooling");
	}
	return notApplicable("no mutation-testing harness configured (muter); skippable → N/A");
};
