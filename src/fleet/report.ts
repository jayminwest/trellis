/**
 * Fleet report renderers (SPEC §11, trellis-8366) — the terminal and markdown
 * projections of a {@link FleetReport}. Pure functions over the report: a
 * fixed-width table for the terminal and a PR/issue-ready markdown table. The
 * JSON projection is the {@link FleetReport} itself (the CLI serializes it
 * directly), so there is no separate JSON renderer here.
 *
 * Both views compute nothing — every index, state, finding count, policy
 * outcome, drift count, and delta comes straight off the report. The index
 * always renders with its direction (`lower is better`, §3.4), and the Δ
 * column is the index move against the target's previous compatible stored
 * run (positive = worse). No ANSI, so they compose with pipes and CI logs.
 */
import type { FleetEntry, FleetReport } from "./orchestrate.ts";

/** Right-pad `s` to `width` for fixed-width columns. */
function pad(s: string, width: number): string {
	return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/** Left-pad `s` to `width` for right-aligned numeric columns. */
function padStart(s: string, width: number): string {
	return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

/** The sloppiness index `12/100`, or `—` for an errored target. */
function indexCell(e: FleetEntry): string {
	return e.ok ? `${e.report.score.index}/100` : "—";
}

/** The completeness state: `complete`, or `partial` for the flagged headline (§3.4). */
function stateCell(e: FleetEntry): string {
	if (!e.ok) return "—";
	return e.report.score.partial ? "partial" : "complete";
}

/** The target's total finding count, or `—` for an errored target. */
function findingsCell(e: FleetEntry): string {
	return e.ok ? `${e.report.findings.length}` : "—";
}

/** `ok` / `FAIL` for the target's declarative policy, `—` for an errored target. */
function policyCell(e: FleetEntry): string {
	if (!e.ok) return "—";
	return e.policy.failed ? "FAIL" : "ok";
}

/** Failing-state drift counts (`drift N · miss N`), `error` when drift itself failed, `—` on target error. */
function driftCell(e: FleetEntry): string {
	if (!e.ok) return "—";
	if (e.drift === null) return e.driftError === null ? "—" : "error";
	return `drift ${e.drift.drift} · miss ${e.drift.missing}`;
}

/** Index move vs the previous run: `+2` (worse) / `0` / `-3` (better), `new` on a first run, `—` on error. */
function deltaCell(e: FleetEntry): string {
	if (!e.ok) return "—";
	if (e.indexDelta === null) return "new";
	return e.indexDelta > 0 ? `+${e.indexDelta}` : `${e.indexDelta}`;
}

/** The error message for a failed target; the drift error as a note; empty otherwise. */
function noteCell(e: FleetEntry): string {
	if (!e.ok) return `error: ${e.error}`;
	return e.driftError === null ? "" : `drift error: ${e.driftError}`;
}

/** `3 targets · 2 ok · 1 error · 1 policy failed` — the headline counts. */
function headline(report: FleetReport): string {
	const { ok, error, policyFailed } = report.summary;
	return `${report.entries.length} targets · ${ok} ok · ${error} error · ${policyFailed} policy failed`;
}

/** Render a fleet report as the default human-readable terminal table. */
export function renderFleetTerminal(report: FleetReport): string {
	const idWidth = Math.max(6, ...report.entries.map((e) => e.id.length));
	const driftWidth = Math.max(5, ...report.entries.map((e) => driftCell(e).length));
	const lines = [
		`trellis fleet · ${headline(report)}`,
		`audited ${report.auditedAt} · index 0–100, lower is better`,
		"",
		`  ${pad("target", idWidth)}  ${padStart("index", 6)}  ${pad("state", 8)}  ${padStart("findings", 8)}  ${pad("policy", 6)}  ${pad("drift", driftWidth)}  ${pad("Δ", 4)}  note`,
	];
	for (const e of report.entries) {
		lines.push(
			`  ${pad(e.id, idWidth)}  ${padStart(indexCell(e), 6)}  ${pad(stateCell(e), 8)}  ${padStart(findingsCell(e), 8)}  ${pad(policyCell(e), 6)}  ${pad(driftCell(e), driftWidth)}  ${pad(deltaCell(e), 4)}  ${noteCell(e)}`.trimEnd(),
		);
	}
	lines.push("");
	lines.push(headline(report));
	return lines.join("\n");
}

/** Render a fleet report as a PR/issue-ready markdown table. */
export function renderFleetMarkdown(report: FleetReport): string {
	const lines = [
		"# Fleet audit",
		"",
		`${headline(report)} · audited ${report.auditedAt}`,
		"Sloppiness index 0–100, **lower is better**; Δ is the index move vs the previous stored run (positive = worse).",
		"",
		"| Target | Index | State | Findings | Policy | Drift | Δ | Note |",
		"| --- | --- | --- | --- | --- | --- | --- | --- |",
	];
	for (const e of report.entries) {
		const note = noteCell(e).replace(/\|/g, "\\|");
		lines.push(
			`| \`${e.id}\` | ${indexCell(e)} | ${stateCell(e)} | ${findingsCell(e)} | ${policyCell(e)} | ${driftCell(e)} | ${deltaCell(e)} | ${note} |`,
		);
	}
	lines.push("");
	return lines.join("\n");
}
