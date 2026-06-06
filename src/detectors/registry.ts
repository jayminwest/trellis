/**
 * Criterion → detector registry (SPEC §8.1, §3.2) — the resolution seam between
 * the tool-agnostic WHAT (rubric criterion ids) and the tool-specific HOW
 * (detectors in `common/` and the per-language adapters).
 *
 * A criterion binds one of two ways: a single **common** (language-agnostic)
 * detector, or a **per-language** map picking an adapter from the app's
 * languages. Resolution is total and never throws: a criterion with no binding —
 * or a per-language binding with no adapter for any of the app's languages —
 * resolves to a `no-detector` stub with a clear rationale. That is the §3.2
 * discipline made structural: an unmeasured deterministic criterion is honestly
 * `no-detector` (drags coverage down), never a crash and never a false pass.
 *
 * Real detector implementations land in later issues (common: trellis-d600;
 * TypeScript: trellis-299e; Swift: trellis-3d67; Python: trellis-89b4; os-eco:
 * trellis-7f70) and populate {@link BINDINGS}. Until then every deterministic
 * criterion resolves through the `no-detector` fallback — which still satisfies
 * the "covers all 70" contract, since resolution always yields a detector.
 */
import { type Detector, type Language, noDetector } from "./types.ts";

/** A criterion binding: one common detector, or a per-language adapter map. */
export type Binding =
	| { readonly kind: "common"; readonly detector: Detector }
	| {
			readonly kind: "language";
			readonly byLanguage: Readonly<Partial<Record<Language, Detector>>>;
	  };

/** Bind a criterion to a single language-agnostic detector. */
export function commonBinding(detector: Detector): Binding {
	return { kind: "common", detector };
}

/** Bind a criterion to per-language adapters (resolved against the app's languages). */
export function languageBinding(byLanguage: Partial<Record<Language, Detector>>): Binding {
	return { kind: "language", byLanguage };
}

/**
 * The authored criterion → detector bindings. Empty until the detector issues
 * populate it; the registry's fallback covers every unbound criterion. Keys must
 * be **deterministic** criterion ids — binding an agent criterion is a wiring
 * bug the registry tests catch by cross-checking keys against the rubric.
 */
export const BINDINGS: Readonly<Record<string, Binding>> = {};

/** No-detector stub for a criterion with no binding at all. */
function unboundStub(criterionId: string): Detector {
	return async () => noDetector(`no detector bound for criterion '${criterionId}'`);
}

/** No-detector stub for a per-language criterion with no adapter for the app's languages. */
function noAdapterStub(
	criterionId: string,
	appLanguages: readonly Language[],
	bound: Language[],
): Detector {
	const have = appLanguages.length > 0 ? appLanguages.join(", ") : "none";
	const want = bound.length > 0 ? bound.join(", ") : "none";
	return async () =>
		noDetector(
			`no adapter for criterion '${criterionId}': app languages [${have}], bound adapters [${want}]`,
		);
}

/**
 * Criterion → detector resolution. Construct from the authored {@link BINDINGS}
 * via {@link REGISTRY}, or with an explicit map in tests.
 */
export class DetectorRegistry {
	private readonly bindings: ReadonlyMap<string, Binding>;

	constructor(bindings: Readonly<Record<string, Binding>> = BINDINGS) {
		this.bindings = new Map(Object.entries(bindings));
	}

	/** True if `criterionId` has an explicit binding (vs. relying on the fallback). */
	has(criterionId: string): boolean {
		return this.bindings.has(criterionId);
	}

	/** The ids with an explicit binding (for cross-checks against the rubric). */
	boundIds(): string[] {
		return [...this.bindings.keys()];
	}

	/**
	 * Resolve a criterion to a detector for an app with `languages`. Precedence:
	 * 1. a per-language adapter for the **first** of the app's languages that has
	 *    one (app-language order wins);
	 * 2. a common detector;
	 * 3. otherwise a `no-detector` stub.
	 * Always returns a detector — never throws.
	 */
	resolve(criterionId: string, languages: readonly Language[] = []): Detector {
		const binding = this.bindings.get(criterionId);
		if (binding === undefined) return unboundStub(criterionId);
		if (binding.kind === "common") return binding.detector;
		for (const lang of languages) {
			const detector = binding.byLanguage[lang];
			if (detector !== undefined) return detector;
		}
		return noAdapterStub(criterionId, languages, Object.keys(binding.byLanguage) as Language[]);
	}
}

/** The registry built from the authored {@link BINDINGS}. */
export const REGISTRY = new DetectorRegistry();
