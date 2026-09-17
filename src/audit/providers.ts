/**
 * Declarative provider selection → the audit's execution plan and evidence
 * (SPEC §16.3–16.5, plan `pl-43c5` step 15 — trellis-15e3).
 *
 * The `providers` block of the audit configuration (§6.5,
 * `src/contract/config.ts`) is pure data: {@link providerExecutionPlan}
 * translates it into a **deterministic execution plan** — one entry per
 * explicitly requested provider, sorted by provider id — and
 * {@link runProviderAnalyses} executes that plan into the contract's
 * analysis results, which assembly folds into the report's additive
 * evidence area (§6.6) as **advisory, namespaced, unscored** evidence.
 *
 * Invariants (§16.4, §16.5):
 *
 * - **Default selects nothing.** An absent `providers` block (or an empty
 *   one) yields an empty plan: no source is staged, no process is launched,
 *   no scratch is created, and the report is byte-identical to the
 *   native-only pipeline. Only an explicitly requested provider stages a
 *   view or runs anything.
 * - **Delivered providers run per request.** jscpd (the delivered adapter,
 *   `src/providers/jscpd/`) stages the audit's measured production/test
 *   selection through the owned-scratch lifecycle and resolves per run.
 * - **Undelivered or gated providers resolve to located `unsupported`
 *   evidence** with the capability table's recorded reason
 *   (`src/providers/capabilities.ts` — including the deferred SonarJS
 *   decision, §16.7): a request is valid configuration even when the
 *   capability cannot execute, and the recorded reason — never a fabricated
 *   clean result — is the surface (§16.2).
 * - **Provider evidence never scores and never displaces native results**
 *   (§16.5): every result here is `kind: "external"` with namespaced ids;
 *   assembly keeps it out of the report's metrics map and findings list.
 * - **Cancellation and cleanup propagate** (§16.4): the audit's cancellation
 *   handle flows to staging, the adapter and every provider process, and
 *   owned scratch is cleaned on every exit path; a cancelled or failed
 *   provider is located evidence, never an abort of the native audit.
 */
import { MEASURED_SOURCE_SETS } from "../analysis/index.ts";
import type { AnalysisResult, AuditConfig, CloneMatchMode } from "../contract/index.ts";
import type { SourceInventory } from "../discovery/index.ts";
import { providerCapabilityStatus } from "../providers/capabilities.ts";
import { runJscpdAnalysis } from "../providers/jscpd/analysis.ts";
import type { PinnedToolResolveOptions } from "../providers/resolve.ts";
import type { StagedSelectionFile } from "../providers/staging.ts";

/** One planned external-provider analysis: the requested provider and its request data. */
export type ProviderAnalysisPlanEntry =
	| { readonly providerId: "jscpd"; readonly mode: CloneMatchMode }
	| { readonly providerId: "dependency-cruiser" | "knip" | "sonarjs" };

/**
 * Translate the declarative `providers` block into the deterministic
 * execution plan: one entry per requested provider, sorted by provider id.
 * The configuration schema (§6.5) has already rejected unknown ids and
 * malformed request data, so the plan is a pure projection — no validation,
 * no I/O, no execution.
 */
export function providerExecutionPlan(config: AuditConfig): readonly ProviderAnalysisPlanEntry[] {
	const { providers } = config;
	const entries: ProviderAnalysisPlanEntry[] = [];
	if (providers.jscpd !== undefined) {
		entries.push({ providerId: "jscpd", mode: providers.jscpd.mode });
	}
	for (const providerId of ["dependency-cruiser", "knip", "sonarjs"] as const) {
		if (providers[providerId] !== undefined) entries.push({ providerId });
	}
	return entries.sort((a, b) =>
		a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0,
	);
}

/** Options for {@link runProviderAnalyses}. */
export interface ProviderAnalysisOptions {
	/** Cancellation handle, propagated to staging, the adapter and every provider process. */
	signal?: AbortSignal;
	/**
	 * Pinned-tool resolution options — the documented test seam for located
	 * resolution failures (`JscpdRequest.resolve`). The default resolves
	 * from trellis's own module tree against the real environment.
	 */
	resolve?: PinnedToolResolveOptions;
}

/**
 * The staged selection for an external provider analysis: the audit's
 * measured production/test files with their classification and package
 * boundaries preserved — the same measured sets the native duplication
 * analyzer selects (`MEASURED_SOURCE_SETS`), so provider evidence rides
 * alongside the native result over the same scope.
 */
export function measuredSelection(source: SourceInventory): StagedSelectionFile[] {
	const measured = new Set<string>(MEASURED_SOURCE_SETS);
	return source.files
		.filter((file) => measured.has(file.sourceSet))
		.map((file) => ({ path: file.path, sourceSet: file.sourceSet, packagePath: file.packagePath }));
}

/**
 * The located `unsupported` evidence for a requested provider whose adapter
 * is not delivered (or is gated by a recorded decision, §16.7): the
 * capability table's recorded reason, never a fabricated clean result. The
 * `0.0.0` versions record that no pinned artifact and no adapter exist
 * while the entry stands; `mode` records that the request names the
 * capability set, not a delivered analysis mode.
 */
export function undeliveredProviderEvidence(
	providerId: "dependency-cruiser" | "knip" | "sonarjs",
): AnalysisResult {
	const status = providerCapabilityStatus(providerId);
	if (status === undefined) {
		throw new Error(
			`provider "${providerId}" has no capability record — the config schema and the supported-provider table have drifted`,
		);
	}
	const note =
		status.decision === undefined
			? ""
			: ` (deferred by ${status.decision.record}, issue ${status.decision.issue}; prerequisite ${status.decision.prerequisite})`;
	return {
		provider: {
			kind: "external",
			id: providerId,
			toolVersion: "0.0.0",
			adapterVersion: "0.0.0",
			mode: "capability-request",
			options: {},
		},
		state: "unsupported",
		reason: `${status.reason}${note}`,
	};
}

/**
 * Execute the configuration's provider plan over the audited workspace and
 * return the contract results (see the module docblock). Ordered by provider
 * id; a default (empty) plan returns `[]` without touching the filesystem.
 * Every execution outcome — including staging failures, cancellations and
 * adapter errors — is located evidence; only a drifted capability table
 * throws (an operational error: the configuration vocabulary and the
 * capability metadata disagree).
 */
export async function runProviderAnalyses(
	root: string,
	source: SourceInventory,
	config: AuditConfig,
	options: ProviderAnalysisOptions = {},
): Promise<readonly AnalysisResult[]> {
	const plan = providerExecutionPlan(config);
	if (plan.length === 0) return [];
	const results: AnalysisResult[] = [];
	for (const entry of plan) {
		if (entry.providerId === "jscpd") {
			results.push(
				await runJscpdAnalysis(root, measuredSelection(source), entry.mode, {
					...(options.signal === undefined ? {} : { signal: options.signal }),
					...(options.resolve === undefined ? {} : { resolve: options.resolve }),
				}),
			);
			continue;
		}
		results.push(undeliveredProviderEvidence(entry.providerId));
	}
	return results;
}
