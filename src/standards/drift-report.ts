/**
 * Drift renderers (SPEC §10) — the three projections of a {@link DriftReport}
 * the `trellis drift` command and the audit report's `report.drift` section
 * surface. Pure functions over the report: a per-file state table for the
 * terminal, a PR/issue-ready markdown table, and the canonical JSON document.
 * They compute nothing — every count comes from {@link DriftReport.summary}.
 */
import type { DriftReport, FileDrift } from "./drift.ts";
import type { DriftState } from "./drift-states.ts";

/** Glyph per state for the human table — pure ASCII so it composes with pipes/CI. */
const STATE_GLYPH: Record<DriftState, string> = {
	match: "ok",
	"allowed-delta": "allow",
	drift: "DRIFT",
	missing: "MISS",
	extra: "extra",
};

/** One-line note for a file's state: the divergences (drift) or allow reasons. */
function fileNote(file: FileDrift): string {
	if (file.state === "drift" || file.state === "extra") {
		return file.divergences
			.map((d) => (d.path === "" ? d.detail : `${d.path}: ${d.detail}`))
			.join("; ");
	}
	if (file.state === "allowed-delta") {
		return file.allowedBy.map((d) => d.reason).join("; ");
	}
	return "";
}

/** Right-pad `s` to `width` for fixed-width columns. */
function pad(s: string, width: number): string {
	return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/** `match 4 · extra 1 · drift 2 · missing 0 · allowed-delta 1` — the headline counts. */
function summaryLine(report: DriftReport): string {
	const s = report.summary;
	return `match ${s.match} · extra ${s.extra} · drift ${s.drift} · missing ${s.missing} · allowed ${s["allowed-delta"]}`;
}

/** Render a drift report as the default human-readable terminal table. */
export function renderDriftTerminal(report: DriftReport): string {
	const pathWidth = Math.max(4, ...report.files.map((f) => f.path.length));
	const lines = [
		`trellis drift · ${report.repo} · canonical ${report.canonicalVersion}`,
		"",
		`  ${pad("file", pathWidth)}  ${pad("state", 6)}  ${pad("matcher", 11)}  note`,
	];
	for (const file of report.files) {
		const note = fileNote(file);
		lines.push(
			`  ${pad(file.path, pathWidth)}  ${pad(STATE_GLYPH[file.state], 6)}  ${pad(file.matcher, 11)}  ${note}`.trimEnd(),
		);
	}
	lines.push("");
	lines.push(summaryLine(report));
	return lines.join("\n");
}

/** Render a drift report as a PR/issue-ready markdown table. */
export function renderDriftMarkdown(report: DriftReport): string {
	const lines = [
		`# Canonical drift — \`${report.repo}\``,
		"",
		`Canonical \`${report.canonicalVersion}\` · ${summaryLine(report)}`,
		"",
		"| File | State | Matcher | Note |",
		"| --- | --- | --- | --- |",
	];
	for (const file of report.files) {
		const note = fileNote(file).replace(/\|/g, "\\|");
		lines.push(`| \`${file.path}\` | ${file.state} | ${file.matcher} | ${note} |`);
	}
	lines.push("");
	return lines.join("\n");
}
