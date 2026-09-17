/**
 * Evidence-basis comparison (SPEC §16.6 — plan `pl-43c5` step 6, trellis-bd0c).
 *
 * Compatibility is evaluated **per measurement** over the recorded analysis
 * identity (§16.2) — never per whole report, and never by assuming a core
 * version alone establishes comparable evidence. Each provider carried on
 * either side gets its own verdict:
 *
 * - **Producer semantics** — provider identity (pinned tool/adapter version,
 *   mode, provider options), the parser that read the inputs, and the
 *   normalized analysis options. A change here is a different measurement:
 *   the provider's evidence is `noncomparable` with a reason per changed
 *   component — never diffed into fictitious improvement/regression or
 *   new/resolved finding churn.
 * - **Scope semantics** — the selected source sets and file paths (never
 *   the content fingerprints). A changed selection is a different analysis
 *   (§16.6 input/config identity): `noncomparable`, never silently trended.
 * - **Content provenance** — the selected files' fingerprints. A revision
 *   change is the *expected input* of a comparison: the evidence still
 *   compares, with an explicit `input-revision-changed` caveat on external
 *   entries so the diff is read as the revision, not a measurement change.
 *
 * Absence is explicit, never a failure: a provider not carried on a side
 * (or carried `unrequested`) reads as `unrequested` there — never as a
 * regression, an `unavailable` failure, or resolved-finding churn. A
 * pre-provider (schema 1.0.0) report carries no analyses at all, so every
 * provider on the other side reads as not carried there.
 *
 * Diffs are computed only for **external** entries carrying measured output
 * (namespaced metrics/findings inside the entry) and only when both sides
 * are `complete` with identical producer and scope semantics — partial or
 * absent evidence is never diffed. Native entries never duplicate the
 * report's own metrics/findings (§6.6): their entry verdict is the
 * recorded-identity view, while their values are diffed by the scored-basis
 * comparison (`compare.ts`), which this evidence verdict never fragments.
 */
import {
	type AnalysisIdentity,
	type AuditReport,
	canonicalOptions,
	carriedAnalyses,
	type ProviderIdentity,
	type ProviderState,
	type ReportAnalysis,
	type ScoringRole,
} from "../contract/index.ts";
import {
	compareFindings,
	compareMetricValues,
	type FindingComparison,
	type MetricDelta,
} from "./diff.ts";

/** Machine-readable codes for per-measurement evidence facts (see the module docblock). */
export type EvidenceIssueCode =
	| "provider-identity"
	| "parser-identity"
	| "analysis-options"
	| "selection"
	| "state-gap"
	| "not-carried"
	| "input-revision-changed";

/** A coded, human-readable per-measurement fact about one provider's evidence. */
export interface EvidenceIssue {
	code: EvidenceIssueCode;
	message: string;
}

/** What a per-provider comparison concluded (see the module docblock). */
export type EvidenceProviderStatus =
	/** Both sides complete with identical producer/scope semantics — evidence diffed (external entries). */
	| "comparable"
	/** Carried on both sides, but the recorded basis differs or a side shows a gap — never diffed. */
	| "noncomparable"
	/** Not carried (or `unrequested`) on either side — an explicit absence, nothing to compare. */
	| "unrequested"
	/** Carried on the current side only; the baseline side reads as unrequested. */
	| "absent-on-baseline"
	/** Carried on the baseline side only; the current side reads as unrequested. */
	| "absent-on-current";

/** One side of a per-provider comparison. */
export interface EvidenceSide {
	/** The carried state, or `unrequested` when the report does not carry the provider. */
	state: ProviderState;
	/** The scoring role the side declares for the provider; `null` when not carried. */
	scoring: ScoringRole | null;
}

/** One provider's evidence comparison across the two reports. */
export interface EvidenceProviderComparison {
	/** The provider's stable id (`jscpd`, `trellis.duplication`, …). */
	providerId: string;
	status: EvidenceProviderStatus;
	baseline: EvidenceSide;
	current: EvidenceSide;
	/** Why the provider's evidence was not diffed; empty when it was (or there is nothing to diff). */
	reasons: EvidenceIssue[];
	/** Caveats recorded on a diffed entry (the source revision changed under identical semantics). */
	caveats: EvidenceIssue[];
	/**
	 * Deltas over the entry's namespaced metrics — external entries only
	 * (native evidence lives in the report's metrics map and is diffed by
	 * the scored-basis comparison, never duplicated here).
	 */
	metrics?: MetricDelta[];
	/** The finding classification over the entry's namespaced findings — external entries only. */
	findings?: FindingComparison;
}

/** The per-provider evidence-basis comparison: one entry per carried provider id, sorted by id. */
export interface EvidenceComparison {
	providers: EvidenceProviderComparison[];
}

/** A carried analysis's producer semantics: the identities that made the measurement, never the content. */
export interface CarriedProducer {
	provider: ProviderIdentity;
	analysis: AnalysisIdentity;
}

/** The producer semantics of a carried entry, or `null` when it recorded no analysis identity. */
function carriedProducer(entry: ReportAnalysis): CarriedProducer | null {
	return entry.analysis === undefined
		? null
		: { provider: entry.provider, analysis: entry.analysis };
}

/** A short human label for a provider identity (bounded: no option dumps). */
function providerLabel(provider: ProviderIdentity): string {
	return `${provider.id} ${provider.toolVersion} (adapter ${provider.adapterVersion}, mode ${provider.mode})`;
}

/** The canonical serialization of one option set (sorted keys, §16.2). */
function optionsLabel(options: ReturnType<typeof canonicalOptions>): string {
	return JSON.stringify(options);
}

/**
 * Which producer-semantics components differ between two carried analyses
 * (§16.2): provider identity, parser, or normalized options — one coded
 * reason per changed component, never a whole-report verdict.
 */
export function producerSemanticsDifferences(
	baseline: CarriedProducer,
	current: CarriedProducer,
): EvidenceIssue[] {
	const issues: EvidenceIssue[] = [];
	if (
		baseline.provider.kind !== current.provider.kind ||
		baseline.provider.toolVersion !== current.provider.toolVersion ||
		baseline.provider.adapterVersion !== current.provider.adapterVersion ||
		baseline.provider.mode !== current.provider.mode ||
		optionsLabel(canonicalOptions(baseline.provider.options)) !==
			optionsLabel(canonicalOptions(current.provider.options))
	) {
		issues.push({
			code: "provider-identity",
			message: `provider identity differs (${providerLabel(baseline.provider)} vs ${providerLabel(current.provider)}): the pinned tool or its wiring changed`,
		});
	}
	if (JSON.stringify(baseline.analysis.parser) !== JSON.stringify(current.analysis.parser)) {
		issues.push({
			code: "parser-identity",
			message: `parser differs (${baseline.analysis.parser.engine} ${baseline.analysis.parser.version} vs ${current.analysis.parser.engine} ${current.analysis.parser.version}): the same evidence cannot continue across parsers`,
		});
	}
	if (
		optionsLabel(canonicalOptions(baseline.analysis.options)) !==
		optionsLabel(canonicalOptions(current.analysis.options))
	) {
		issues.push({
			code: "analysis-options",
			message: `normalized analysis options differ (${optionsLabel(canonicalOptions(baseline.analysis.options))} vs ${optionsLabel(canonicalOptions(current.analysis.options))}): the normalized configuration changed`,
		});
	}
	return issues;
}

/** Which scope semantics differ between two selections: the source sets and/or the selected paths (bounded messages). */
function selectionDifferences(
	baseline: AnalysisIdentity,
	current: AnalysisIdentity,
): EvidenceIssue[] {
	const issues: EvidenceIssue[] = [];
	if (
		JSON.stringify(baseline.selection.sourceSets) !== JSON.stringify(current.selection.sourceSets)
	) {
		issues.push({
			code: "selection",
			message: `source sets differ (${baseline.selection.sourceSets.join(", ")} vs ${current.selection.sourceSets.join(", ")}): the analysis selected a different scope`,
		});
	}
	if (
		JSON.stringify(baseline.selection.files.map((file) => file.path)) !==
		JSON.stringify(current.selection.files.map((file) => file.path))
	) {
		issues.push({
			code: "selection",
			message: `selected file sets differ (${baseline.selection.files.length} vs ${current.selection.files.length} files): the analysis selected different inputs`,
		});
	}
	return issues;
}

/** The content fingerprints of a selection — provenance, compared separately from scope and producer semantics. */
function contentFingerprints(analysis: AnalysisIdentity): string {
	return JSON.stringify(analysis.selection.files.map((file) => [file.path, file.fingerprint]));
}

/** The carried entries of one report, keyed by provider id. */
function carriedByProvider(report: AuditReport): Map<string, ReportAnalysis> {
	return new Map(carriedAnalyses(report).map((entry) => [entry.provider.id, entry]));
}

/** How one side carries a provider: absent (not carried or unrequested), a state gap, or complete with identity. */
type CarriedKind = "absent" | "gap" | "complete";

function carriedKind(entry: ReportAnalysis | undefined): CarriedKind {
	if (entry === undefined || entry.state === "unrequested") return "absent";
	if (entry.state === "complete" && entry.analysis !== undefined) return "complete";
	return "gap";
}

function sideOf(entry: ReportAnalysis | undefined): EvidenceSide {
	return entry === undefined
		? { state: "unrequested", scoring: null }
		: { state: entry.state, scoring: entry.scoring };
}

/** The not-carried reason for one side: explicit unrequested absence, never a regression (§16.6). */
function notCarriedIssue(
	providerId: string,
	side: "baseline" | "current",
	report: AuditReport,
): EvidenceIssue {
	const preProvider = report.schemaVersion === "1.0.0";
	return {
		code: "not-carried",
		message: preProvider
			? `the ${side} report (schema 1.0.0) predates the provider-evidence area: "${providerId}" reads as unrequested there, never as a regression`
			: `the ${side} report does not request "${providerId}": it reads as unrequested, never as a regression or an unavailable failure`,
	};
}

/** The state-gap reason for one side: partial or absent evidence is never diffed as churn. */
function stateGapIssue(side: "baseline" | "current", entry: ReportAnalysis): EvidenceIssue {
	return {
		code: "state-gap",
		message: `the ${side} analysis is ${entry.state}: partial or absent evidence is never diffed as new/resolved churn`,
	};
}

/** Resolve a provider carried on exactly one side: an explicit unrequested absence (§16.6). */
function resolveAbsence(
	result: EvidenceProviderComparison,
	baselineKind: CarriedKind,
	providerId: string,
	baseline: AuditReport,
	current: AuditReport,
): void {
	if (baselineKind === "absent") {
		result.status = "absent-on-baseline";
		result.reasons.push(notCarriedIssue(providerId, "baseline", baseline));
		return;
	}
	result.status = "absent-on-current";
	result.reasons.push(notCarriedIssue(providerId, "current", current));
}

/** Resolve a provider showing a state gap on a side: located, never diffed as churn. */
function resolveGaps(
	result: EvidenceProviderComparison,
	baselineKind: CarriedKind,
	currentKind: CarriedKind,
	baselineEntry: ReportAnalysis | undefined,
	currentEntry: ReportAnalysis | undefined,
): void {
	if (baselineKind === "gap" && baselineEntry !== undefined) {
		result.reasons.push(stateGapIssue("baseline", baselineEntry));
	}
	if (currentKind === "gap" && currentEntry !== undefined) {
		result.reasons.push(stateGapIssue("current", currentEntry));
	}
}

/** Resolve a provider complete on both sides: evaluate the recorded basis, then diff external evidence. */
function resolveCompletePair(
	result: EvidenceProviderComparison,
	baselineEntry: ReportAnalysis,
	currentEntry: ReportAnalysis,
): void {
	const baselineProducer = carriedProducer(baselineEntry);
	const currentProducer = carriedProducer(currentEntry);
	if (baselineProducer === null || currentProducer === null) return; // unreachable: complete entries carry identity
	const basis = [
		...producerSemanticsDifferences(baselineProducer, currentProducer),
		...selectionDifferences(baselineProducer.analysis, currentProducer.analysis),
	];
	if (basis.length > 0) {
		result.reasons.push(...basis);
		return;
	}
	result.status = "comparable";
	if (baselineProducer.provider.kind !== "external") return; // native evidence lives in the report areas
	if (
		contentFingerprints(baselineProducer.analysis) !== contentFingerprints(currentProducer.analysis)
	) {
		result.caveats.push({
			code: "input-revision-changed",
			message:
				"the selected files' content fingerprints differ between the runs: the evidence diff reflects the source revision, not a measurement change",
		});
	}
	result.metrics = compareMetricValues(baselineEntry.metrics ?? [], currentEntry.metrics ?? []);
	result.findings = compareFindings(baselineEntry.findings ?? [], currentEntry.findings ?? []);
}

function compareProvider(
	providerId: string,
	baseline: AuditReport,
	current: AuditReport,
	baselineEntry: ReportAnalysis | undefined,
	currentEntry: ReportAnalysis | undefined,
): EvidenceProviderComparison {
	const result: EvidenceProviderComparison = {
		providerId,
		status: "noncomparable",
		baseline: sideOf(baselineEntry),
		current: sideOf(currentEntry),
		reasons: [],
		caveats: [],
	};
	const baselineKind = carriedKind(baselineEntry);
	const currentKind = carriedKind(currentEntry);

	if (baselineKind === "absent" && currentKind === "absent") {
		result.status = "unrequested";
		return result;
	}
	if (baselineKind === "absent" || currentKind === "absent") {
		resolveAbsence(result, baselineKind, providerId, baseline, current);
		return result;
	}
	if (baselineKind === "gap" || currentKind === "gap") {
		resolveGaps(result, baselineKind, currentKind, baselineEntry, currentEntry);
		return result;
	}
	// Both sides are complete with recorded identities: evaluate per basis.
	if (baselineEntry !== undefined && currentEntry !== undefined) {
		resolveCompletePair(result, baselineEntry, currentEntry);
	}
	return result;
}

/**
 * Compare the two reports' provider evidence per measurement (see the module
 * docblock): one entry per provider id carried on either side, sorted by id,
 * each with its own status, reasons, caveats and (external, comparable
 * entries only) namespaced metric/finding diffs. Pure: no I/O. The scored
 * basis (`compare.ts`) never consumes this — the two bases are independent.
 */
export function compareEvidence(baseline: AuditReport, current: AuditReport): EvidenceComparison {
	const baselineById = carriedByProvider(baseline);
	const currentById = carriedByProvider(current);
	const ids = [...new Set([...baselineById.keys(), ...currentById.keys()])].sort();
	return {
		providers: ids.map((id) =>
			compareProvider(id, baseline, current, baselineById.get(id), currentById.get(id)),
		),
	};
}
