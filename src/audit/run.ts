/**
 * Audit run service (SPEC §12, §13.1, trellis-9a88) — the composition the CLI
 * and SDK both fold, wrapping the pure measurement pass
 * ({@link auditWorkspace}) with the downstream steps of the §4 pipeline:
 *
 *   configure → auditWorkspace (pure) → resolve baseline → assess policy
 *   → persist, if asked
 *
 * One code path: the CLI's `trellis audit` and the SDK's `audit()` call this
 * exact function, so a terminal audit and a programmatic audit can never
 * drift (the deep-equal parity test proves it).
 *
 * **Stateless by default (SPEC §8, §10).** No database is opened and no file
 * is written unless `history` is opted into — then the run appends to the
 * central SQLite history (`db` overrides its location) and, absent an
 * explicit `baselinePath`, the baseline resolves to the latest stored run
 * whose scored basis is compatible with the new report (read before the new
 * run is inserted).
 *
 * **Policy (SPEC §6.5, §9).** The declarative `policy` block of the resolved
 * configuration is evaluated independently of scoring; the structured
 * {@link PolicyAssessment} comes back on the result for the caller to map
 * onto its exit-code contract (CLI: `2` when tripped, report still emitted).
 *
 * Operational errors only ever throw: an unreadable root, an invalid
 * `trellis.yaml`, an unloadable baseline artifact
 * ({@link ReportArtifactError}), or retired readiness/investigation options
 * ({@link AuditRunError} / {@link LegacyConfigError}).
 */
import { assessPolicy, loadReportArtifact, type PolicyAssessment } from "../compare/index.ts";
import { loadAuditConfig, loadAuditConfigFile } from "../config/index.ts";
import type { AuditConfig, AuditReport } from "../contract/index.ts";
import { LegacyConfigError, legacyConfigMessage, retiredReadinessMessage } from "../legacy.ts";
import type { DuplicationBudget } from "../metrics/index.ts";
import { openStore, repoIdentity, storedAuditReport } from "../store/index.ts";
import { auditWorkspace } from "./audit.ts";
import type { AuditProgress } from "./progress.ts";

/** An operational failure in the audit run service (bad options, bad config). */
export class AuditRunError extends Error {
	override readonly name = "AuditRunError";
}

/** Options for {@link runWorkspaceAudit} — the user-facing audit surface (mirrors the CLI flags). */
export interface WorkspaceAuditOptions {
	/** Preloaded audit configuration (§6.5); wins over `configPath`. Pass at most one. */
	config?: AuditConfig;
	/** Explicit `trellis.yaml` path (the `--config` flag); default discovers at the root. */
	configPath?: string;
	/** Saved baseline report artifact (§9); absent → the opt-in history supplies the baseline. */
	baselinePath?: string;
	/** Opt-in persistence (SPEC §10): record the run and resolve a stored baseline. Default false. */
	history?: boolean;
	/** SQLite history path (meaningful only with `history`); defaults to `$TRELLIS_DB` or `~/.trellis/trellis.db`. */
	db?: string;
	/** Duplication resource budgets (SPEC §5.3); a resource knob, never a scoring input. */
	duplicationBudget?: DuplicationBudget;
	/** Optional bounded progress sink; the CLI renders these events to stderr. */
	onProgress?: AuditProgress;
	/** Wall-clock for `run.auditedAt` (determinism hook); defaults to now. */
	now?: Date;
}

/** The outcome of one audit run: the report plus its policy assessment and provenance. */
export interface WorkspaceAuditResult {
	/** The §6.4 report the deterministic core assembled. */
	report: AuditReport;
	/** The independent §9 policy evaluation over the resolved configuration's `policy` block. */
	policy: PolicyAssessment;
	/** The baseline the policy compared against, when one was resolved. */
	baseline?: AuditReport;
	/** The `audit_runs` row id, present exactly when the run was persisted (`history`). */
	historyRunId?: number;
}

/** Option-bag keys retired with the readiness product (SPEC §14 stage 9), rejected actionably. */
const RETIRED_READINESS_KEYS = [
	"rubric",
	"rubricDir",
	"rubricVersion",
	"minLevel",
	"failOn",
	"canonical",
	"persist",
	"repoId",
	"output",
] as const;

/**
 * Reject retired knobs on the public options bag. TypeScript callers get a
 * compile error from the narrowed option type; this guard gives untyped
 * callers the same actionable failure instead of a silent ignore — the
 * investigation-era keys via {@link legacyConfigMessage}, the readiness-era
 * keys via {@link retiredReadinessMessage}.
 */
function rejectRetiredOptions(opts: object): void {
	for (const key of ["noCache", "piBin", "investigation", "provider", "model"]) {
		if (key in opts) throw new LegacyConfigError(legacyConfigMessage(`option '${key}'`));
	}
	for (const key of RETIRED_READINESS_KEYS) {
		if (key in opts) throw new AuditRunError(retiredReadinessMessage(`option '${key}'`));
	}
}

/** Resolve the audit configuration from the options (at most one explicit source). */
async function resolveConfig(root: string, opts: WorkspaceAuditOptions): Promise<AuditConfig> {
	if (opts.config !== undefined && opts.configPath !== undefined) {
		throw new AuditRunError("pass at most one of config and configPath");
	}
	if (opts.config !== undefined) return opts.config;
	if (opts.configPath !== undefined) return loadAuditConfigFile(opts.configPath);
	return loadAuditConfig(root);
}

/**
 * Persist the run and resolve the stored baseline (SPEC §10): the latest
 * prior run for this repository identity whose scored basis is compatible
 * with the new report (the step-6 verdicts, reused — advisory-only provider
 * changes never fragment the baseline, a changed scored measurement or
 * scoring basis does), read **before** the new run is inserted so a first
 * run has no baseline.
 */
function recordRun(
	report: AuditReport,
	db: string | undefined,
): { baseline?: AuditReport; historyRunId?: number } {
	const store = openStore(db);
	try {
		const identity = repoIdentity(report.repo.root, report.repo.identity);
		const prior = store.latestCompatibleRun(identity, report);
		const historyRunId = store.insertAuditRun(report);
		return {
			...(prior ? { baseline: storedAuditReport(prior) } : {}),
			historyRunId,
		};
	} finally {
		store.close();
	}
}

/**
 * Run one audit end to end (see the module docblock for the contract). The
 * measurement pass itself stays pure — persistence and policy evaluation
 * happen here, outside it (SPEC §4).
 */
export async function runWorkspaceAudit(
	root: string,
	opts: WorkspaceAuditOptions = {},
): Promise<WorkspaceAuditResult> {
	rejectRetiredOptions(opts);
	if (opts.db !== undefined && opts.history !== true) {
		throw new AuditRunError(
			"db is meaningful only with history: audits are stateless by default (SPEC §10) — " +
				"pass --history (CLI) or history: true (SDK) to record the run",
		);
	}
	const config = await resolveConfig(root, opts);
	// Load an explicit baseline up front: a broken artifact is an operational
	// error (ReportArtifactError) and must not cost the measurement pass.
	const explicitBaseline =
		opts.baselinePath === undefined ? undefined : await loadReportArtifact(opts.baselinePath);
	const report = await auditWorkspace(root, {
		config,
		...(opts.duplicationBudget ? { duplicationBudget: opts.duplicationBudget } : {}),
		...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
		...(opts.now ? { now: opts.now } : {}),
	});
	const recorded: { baseline?: AuditReport; historyRunId?: number } =
		opts.history === true ? recordRun(report, opts.db) : {};
	const baseline = explicitBaseline ?? recorded.baseline;
	const policy = assessPolicy(report, config.policy, {
		...(baseline ? { baseline } : {}),
		compare: { currentConfig: config },
	});
	return {
		report,
		policy,
		...(baseline ? { baseline } : {}),
		...(recorded.historyRunId === undefined ? {} : { historyRunId: recorded.historyRunId }),
	};
}
