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
import * as common from "./common/index.ts";
import * as swift from "./lang/swift/index.ts";
import * as ts from "./lang/typescript/index.ts";
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
 * The authored criterion → detector bindings. Per-language adapters (trellis-299e
 * / 3d67 / 89b4) and os-eco-native detectors (trellis-7f70) extend this; the
 * registry's fallback covers every still-unbound criterion. Keys must be
 * **deterministic** criterion ids — binding an agent criterion is a wiring bug
 * the registry tests catch by cross-checking keys against the rubric.
 *
 * Bound here (trellis-d600): the language-agnostic common detectors for §5.4
 * Environment & Setup, §5.5 CI/Release/Deployment, §5.7 Security & Data, §5.8
 * Process & Collaboration, and the language-agnostic §5.2 hygiene checks.
 */
export const BINDINGS: Readonly<Record<string, Binding>> = {
	// §5.4 Environment & Setup
	env_template: commonBinding(common.envTemplate),
	gitignore_comprehensive: commonBinding(common.gitignoreComprehensive),
	deps_pinned: commonBinding(common.depsPinned),
	devcontainer: commonBinding(common.devcontainer),
	// §5.5 CI, Release & Deployment
	vcs_cli_tools: commonBinding(common.vcsCliTools),
	monorepo_tooling: commonBinding(common.monorepoTooling),
	dependency_update_automation: commonBinding(common.dependencyUpdateAutomation),
	release_notes_automation: commonBinding(common.releaseNotesAutomation),
	release_automation: commonBinding(common.releaseAutomation),
	version_drift_detection: commonBinding(common.versionDriftDetection),
	dead_feature_flag_detection: commonBinding(common.deadFeatureFlagDetection),
	feature_flag_infrastructure: commonBinding(common.featureFlagInfrastructure),
	fast_ci_feedback: commonBinding(common.fastCiFeedback),
	build_performance_tracking: commonBinding(common.buildPerformanceTracking),
	deployment_frequency: commonBinding(common.deploymentFrequency),
	progressive_rollout: commonBinding(common.progressiveRollout),
	rollback_automation: commonBinding(common.rollbackAutomation),
	// §5.7 Security & Data
	branch_protection: commonBinding(common.branchProtection),
	automated_security_review: commonBinding(common.automatedSecurityReview),
	secret_scanning: commonBinding(common.secretScanning),
	min_release_age: commonBinding(common.minReleaseAge),
	privacy_compliance: commonBinding(common.privacyCompliance),
	// §5.8 Process & Collaboration
	codeowners: commonBinding(common.codeowners),
	issue_templates: commonBinding(common.issueTemplates),
	issue_labeling_system: commonBinding(common.issueLabelingSystem),
	pr_templates: commonBinding(common.prTemplates),
	automated_pr_review: commonBinding(common.automatedPrReview),
	backlog_health: commonBinding(common.backlogHealth),
	// §5.2 Code Quality (language-agnostic hygiene) + §5.5 pre-commit
	large_file_detection: commonBinding(common.largeFileDetection),
	tech_debt_tracking: commonBinding(common.techDebtTracking),
	pre_commit_hooks: commonBinding(common.preCommitHooks),

	// §5.2 Code Quality — TypeScript (trellis-299e) + Swift (trellis-3d67) adapters
	lint_config: languageBinding({ typescript: ts.lintConfig, swift: swift.lintConfig }),
	type_check: languageBinding({ typescript: ts.typeCheck, swift: swift.typeCheck }),
	formatter: languageBinding({ typescript: ts.formatter, swift: swift.formatter }),
	strict_typing: languageBinding({ typescript: ts.strictTyping, swift: swift.strictTyping }),
	naming_consistency: languageBinding({
		typescript: ts.namingConsistency,
		swift: swift.namingConsistency,
	}),
	dead_code_detection: languageBinding({
		typescript: ts.deadCodeDetection,
		swift: swift.deadCodeDetection,
	}),
	duplicate_code_detection: languageBinding({
		typescript: ts.duplicateCodeDetection,
		swift: swift.duplicateCodeDetection,
	}),
	unused_dependencies_detection: languageBinding({
		typescript: ts.unusedDependenciesDetection,
		swift: swift.unusedDependenciesDetection,
	}),
	code_modularization: languageBinding({ typescript: ts.codeModularization }),
	cyclomatic_complexity: languageBinding({
		typescript: ts.cyclomaticComplexity,
		swift: swift.cyclomaticComplexity,
	}),
	// §5.3 Testing — deterministic TypeScript + Swift subset
	unit_tests_runnable: languageBinding({
		typescript: ts.unitTestsRunnable,
		swift: swift.unitTestsRunnable,
	}),
	test_coverage_thresholds: languageBinding({
		typescript: ts.testCoverageThresholds,
		swift: swift.testCoverageThresholds,
	}),
	// §5.6 Observability — deterministic TypeScript subset
	structured_logging: languageBinding({ typescript: ts.structuredLogging }),
	error_tracking_contextualized: languageBinding({ typescript: ts.errorTrackingContextualized }),
	// §5.9 Locality & Contracts — TypeScript bindings (thesis category); Swift maps the
	// stack-concept criteria to honest not-applicable (no Swift analogue, SPEC §8.3).
	machine_checked_architecture: languageBinding({ typescript: ts.machineCheckedArchitecture }),
	import_cycle_detection: languageBinding({
		typescript: ts.importCycleDetection,
		swift: swift.importCycleDetection,
	}),
	orphan_module_detection: languageBinding({ typescript: ts.orphanModuleDetection }),
	explicit_any_detection: languageBinding({
		typescript: ts.explicitAnyDetection,
		swift: swift.explicitAnyDetection,
	}),
	strictest_type_checking: languageBinding({ typescript: ts.strictestTypeChecking }),
	greppable_exports: languageBinding({
		typescript: ts.greppableExports,
		swift: swift.greppableExports,
	}),
	barrel_file_reexport_detection: languageBinding({
		typescript: ts.barrelFileReexportDetection,
		swift: swift.barrelFileReexportDetection,
	}),
	mutation_testing: languageBinding({
		typescript: ts.mutationTesting,
		swift: swift.mutationTesting,
	}),
};

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
