/**
 * Artifact-comparison service (SPEC §9, §12, trellis-9a88) — the
 * `trellis compare <a.json> <b.json>` composition the CLI and SDK both fold:
 * load two saved report artifacts (operational errors only, via
 * {@link loadReportArtifact}), compare them purely
 * ({@link compareReports}), and — when a configuration is supplied — evaluate
 * its declarative `policy` block with the first artifact as the baseline
 * ({@link assessPolicy}).
 *
 * No audit runs here, and nothing is written: comparison is a pure function
 * of the two artifacts plus the optional configuration. One code path — the
 * SDK's `compare()` is a direct call to this service.
 */
import { loadAuditConfigFile } from "../config/index.ts";
import type { AuditConfig, AuditReport } from "../contract/index.ts";
import { type CompareOptions, compareReports, type ReportComparison } from "./compare.ts";
import { loadReportArtifact } from "./load.ts";
import { assessPolicy, type PolicyAssessment } from "./policy.ts";

/** Options for {@link runComparison}. */
export interface CompareRunOptions {
	/** Preloaded audit configuration (§6.5); wins over `configPath`. Pass at most one. */
	config?: AuditConfig;
	/** Explicit `trellis.yaml` path (the `--config` flag) whose `policy` block gates the comparison. */
	configPath?: string;
}

/** The outcome of comparing two saved report artifacts. */
export interface CompareRunResult {
	/** The first artifact — the baseline side of the comparison. */
	baseline: AuditReport;
	/** The second artifact — the current side, and the policy's subject. */
	current: AuditReport;
	/** The pure comparison: compatibility, score/metric deltas, finding classification. */
	comparison: ReportComparison;
	/**
	 * The §9 policy evaluation over the supplied configuration's `policy`
	 * block, or `null` when no configuration was supplied (comparison alone
	 * gates nothing).
	 */
	policy: PolicyAssessment | null;
}

/**
 * Compare two saved report artifacts (see the module docblock). Throws only
 * operational errors: an unreadable/invalid artifact
 * ({@link ReportArtifactError}) or an unloadable configuration file.
 */
export async function runComparison(
	baselinePath: string,
	currentPath: string,
	opts: CompareRunOptions = {},
): Promise<CompareRunResult> {
	if (opts.config !== undefined && opts.configPath !== undefined) {
		throw new Error("pass at most one of config and configPath");
	}
	const config =
		opts.config ??
		(opts.configPath === undefined ? undefined : await loadAuditConfigFile(opts.configPath));
	const [baseline, current] = await Promise.all([
		loadReportArtifact(baselinePath),
		loadReportArtifact(currentPath),
	]);
	// The §6.4 report does not carry the audit configuration, so when one is
	// supplied it stands for both sides — a difference would be undetectable
	// here and the operator asserts the artifacts were produced under it.
	const compare: CompareOptions =
		config === undefined ? {} : { baselineConfig: config, currentConfig: config };
	const comparison = compareReports(baseline, current, compare);
	const policy =
		config === undefined ? null : assessPolicy(current, config.policy, { baseline, compare });
	return { baseline, current, comparison, policy };
}
