/**
 * The deterministic audit service (SPEC §4, §12, trellis-9a88) — the one
 * composed entrypoint the CLI (`trellis audit`) and the SDK (`audit()`) both
 * fold, so a programmatic audit and a CLI audit exercise one measurement and
 * policy code path:
 *
 *   configure → auditWorkspace (the pure measurement pass)
 *   → [compare vs baseline] → [evaluate the declarative policy]
 *   → [persist, only when asked]
 *
 * The bracketed stages are the §4 downstream consumers, composed here in
 * their specified order. The measurement pass itself
 * ({@link auditWorkspace}) stays pure: persistence and policy evaluation
 * never reach back into it.
 *
 * Invariants (SPEC §8, §9, §10):
 *
 * - **Stateless by default.** Without `history`, the run opens no database
 *   and writes nothing — no hidden DB, no report files (file output is the
 *   CLI's `--out`, outside this service).
 * - **Policy is declarative.** The failure policy comes from the audited
 *   repo's `trellis.yaml` (§6.5), never from command-line scoring knobs;
 *   {@link assessPolicy} evaluates each configured policy independently.
 * - **Operational vs policy failure.** Unreadable/invalid configuration or
 *   baseline artifacts throw ({@link AuditConfigError},
 *   {@link ReportArtifactError}) — callers map those to the operational
 *   exit (`1`), while a tripped policy is data on the result
 *   ({@link WorkspaceAuditResult.policy}), mapped to exit `2` with the
 *   report already emitted.
 * - **Retired knobs fail loudly.** Readiness-era options (rubric, levels,
 *   `--fail-on`, persist-by-default, …) are rejected via
 *   {@link rejectRetiredAuditOptions}, never silently ignored.
 */

import {
	assessPolicy,
	compareReports,
	loadReportArtifact,
	type PolicyAssessment,
	type ReportComparison,
} from "../compare/index.ts";
import { loadAuditConfig, loadAuditConfigFile } from "../config/index.ts";
import type { AuditConfig, AuditReport } from "../contract/index.ts";
import { rejectRetiredAuditOptions } from "../legacy.ts";
import type { DuplicationBudget } from "../metrics/index.ts";
import { openStore } from "../store/index.ts";
import { auditWorkspace } from "./audit.ts";
import type { AuditProgress } from "./progress.ts";

/** Options for {@link runWorkspaceAudit} — the user-facing audit surface (mirrors the CLI flags). */
export interface WorkspaceAuditOptions {
	/**
	 * Preloaded audit configuration (§6.5). When absent, `configPath` is
	 * loaded, else `trellis.yaml` is discovered at the audited root
	 * (documented defaults when no file exists).
	 */
	config?: AuditConfig;
	/** Explicit configuration file (the CLI's `--config`); a missing file is an operational error. */
	configPath?: string;
	/**
	 * A saved JSON report to compare against (SPEC §9, the CLI's
	 * `--baseline`). Baseline-dependent policies (`regression`, `failOnNew`)
	 * evaluate against it; an incompatible baseline fails closed.
	 */
	baselinePath?: string;
	/**
	 * Opt-in history persistence (SPEC §10): `true` appends the run to the
	 * central SQLite history (`$TRELLIS_DB` or `~/.trellis/trellis.db`);
	 * `{ db }` overrides the location. Absent → stateless, no database.
	 */
	history?: boolean | { db?: string };
	/** Duplication resource budgets (SPEC §5.3); a resource knob, never a scoring input. */
	duplicationBudget?: DuplicationBudget;
	/** Optional bounded progress sink; the CLI renders these events to stderr. */
	onProgress?: AuditProgress;
	/** Wall-clock for `run.auditedAt` (determinism hook); defaults to now. */
	now?: Date;
}

/** The composed audit outcome: the §6.4 report plus its downstream assessments. */
export interface WorkspaceAuditResult {
	/** The §6.4 audit report from the pure measurement pass. */
	report: AuditReport;
	/** The baseline comparison (SPEC §9) — present exactly when `baselinePath` was given. */
	comparison?: ReportComparison;
	/**
	 * The declarative-policy assessment (§6.5, §9) — always present; with no
	 * configured policies it carries zero results and `failed: false`.
	 */
	policy: PolicyAssessment;
	/** The persisted `audit_runs` row id — present exactly when `history` was enabled. */
	historyRunId?: number;
}

/**
 * Audit the workspace at `root` and assess the result (see the module
 * docblock for the invariants). Throws only on operational errors — invalid
 * configuration, an unreadable/invalid baseline artifact, or an unreadable
 * root; a tripped policy is returned, never thrown.
 */
export async function runWorkspaceAudit(
	root: string,
	options: WorkspaceAuditOptions = {},
): Promise<WorkspaceAuditResult> {
	rejectRetiredAuditOptions(options);
	const config =
		options.config ??
		(options.configPath !== undefined
			? await loadAuditConfigFile(options.configPath)
			: await loadAuditConfig(root));
	const baseline =
		options.baselinePath === undefined ? undefined : await loadReportArtifact(options.baselinePath);
	const report = await auditWorkspace(root, {
		config,
		...(options.duplicationBudget ? { duplicationBudget: options.duplicationBudget } : {}),
		...(options.onProgress ? { onProgress: options.onProgress } : {}),
		...(options.now ? { now: options.now } : {}),
	});
	const comparison = baseline
		? compareReports(baseline, report, { currentConfig: config })
		: undefined;
	const policy = assessPolicy(report, config.policy, {
		...(baseline ? { baseline } : {}),
		compare: { currentConfig: config },
	});
	const result: WorkspaceAuditResult = {
		report,
		...(comparison ? { comparison } : {}),
		policy,
	};
	if (options.history !== undefined && options.history !== false) {
		const store = openStore(typeof options.history === "object" ? options.history.db : undefined);
		try {
			result.historyRunId = store.insertAuditRun(report);
		} finally {
			store.close();
		}
	}
	return result;
}
