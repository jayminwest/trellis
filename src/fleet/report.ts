/**
 * Fleet dashboard renderers (SPEC §6.5) — the terminal and markdown projections
 * of a {@link FleetReport}. Pure functions over the report: a fixed-width table
 * for the terminal and a PR/issue-ready markdown table. The JSON projection is
 * the {@link FleetReport} itself (the CLI serializes it directly), so there is no
 * separate JSON renderer here.
 *
 * Both views compute nothing — every level, rate, drift count, and delta comes
 * straight off the report. No ANSI, so they compose with pipes and CI logs.
 */
import { pct } from "../report/index.ts";
import type { FleetEntry, FleetReport } from "./orchestrate.ts";

/** Right-pad `s` to `width` for fixed-width columns. */
function pad(s: string, width: number): string {
	return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/** Left-pad `s` to `width` for right-aligned numeric columns. */
function padStart(s: string, width: number): string {
	return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

/** `L4` for a scored target, `—` for an errored one. */
function levelCell(e: FleetEntry): string {
	return e.ok ? `L${e.level}` : "—";
}

/** Pass-rate as a percent, or `—` for an errored target. */
function passCell(e: FleetEntry): string {
	return e.ok ? pct(e.passRate) : "—";
}

/** Coverage as a percent, or `—` for an errored target. */
function covCell(e: FleetEntry): string {
	return e.ok ? pct(e.coverage) : "—";
}

/** Failing-state drift counts (`drift N · miss N`), `—` when no canonical comparison ran. */
function driftCell(e: FleetEntry): string {
	if (!e.ok || e.drift === null) return "—";
	return `drift ${e.drift.drift} · miss ${e.drift.missing}`;
}

/** Level move vs the previous run: `+1` / `0` / `-1`, `new` for a first run, `—` on error. */
function deltaCell(e: FleetEntry): string {
	if (!e.ok) return "—";
	if (e.levelDelta === null) return "new";
	return e.levelDelta > 0 ? `+${e.levelDelta}` : `${e.levelDelta}`;
}

/** The error message for a failed target; empty for a scored one. */
function noteCell(e: FleetEntry): string {
	return e.ok ? "" : `error: ${e.error}`;
}

/** `3 targets · rubric 1.0.0 · 2 ok · 1 error` — the headline counts. */
function headline(report: FleetReport): string {
	const canonical = report.canonicalVersion ? ` · canonical ${report.canonicalVersion}` : "";
	return `${report.entries.length} targets · rubric ${report.rubricVersion}${canonical} · ${report.summary.ok} ok · ${report.summary.error} error`;
}

/** Render a fleet report as the default human-readable terminal dashboard. */
export function renderFleetTerminal(report: FleetReport): string {
	const idWidth = Math.max(6, ...report.entries.map((e) => e.id.length));
	const driftWidth = Math.max(5, ...report.entries.map((e) => driftCell(e).length));
	const lines = [
		`trellis fleet · ${headline(report)}`,
		`scored ${report.scoredAt}`,
		"",
		`  ${pad("target", idWidth)}  ${pad("level", 5)}  ${padStart("pass", 5)}  ${padStart("cov", 5)}  ${pad("drift", driftWidth)}  ${pad("Δ", 4)}  note`,
	];
	for (const e of report.entries) {
		lines.push(
			`  ${pad(e.id, idWidth)}  ${pad(levelCell(e), 5)}  ${padStart(passCell(e), 5)}  ${padStart(covCell(e), 5)}  ${pad(driftCell(e), driftWidth)}  ${pad(deltaCell(e), 4)}  ${noteCell(e)}`.trimEnd(),
		);
	}
	lines.push("");
	lines.push(`${report.summary.ok} ok · ${report.summary.error} error`);
	return lines.join("\n");
}

/** Render a fleet report as a PR/issue-ready markdown table. */
export function renderFleetMarkdown(report: FleetReport): string {
	const lines = [
		"# Fleet audit",
		"",
		headline(report),
		`scored ${report.scoredAt}`,
		"",
		"| Target | Level | Pass | Coverage | Drift | Δ | Note |",
		"| --- | --- | --- | --- | --- | --- | --- |",
	];
	for (const e of report.entries) {
		const note = noteCell(e).replace(/\|/g, "\\|");
		lines.push(
			`| \`${e.id}\` | ${levelCell(e)} | ${passCell(e)} | ${covCell(e)} | ${driftCell(e)} | ${deltaCell(e)} | ${note} |`,
		);
	}
	lines.push("");
	return lines.join("\n");
}
