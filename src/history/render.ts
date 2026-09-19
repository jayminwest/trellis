/** Terminal and Markdown projections of the audit history dashboard. */
import type {
	AuditRepoHistory,
	AuditRunPoint,
	AuditSnapshotEntry,
	HistoryReport,
} from "./dashboard.ts";

/** Right-pad `s` to `width` for fixed-width columns. */
function pad(s: string, width: number): string {
	return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/** Left-pad `s` to `width` for right-aligned numeric columns. */
function padStart(s: string, width: number): string {
	return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

/** A signed index move: `new` for a first run, `+2` (worse) / `0` / `-3` (better) otherwise. */
function deltaCell(indexDelta: number | null): string {
	if (indexDelta === null) return "new";
	return indexDelta > 0 ? `+${indexDelta}` : `${indexDelta}`;
}

/** `partial` for the flagged headline (§3.4), `complete` otherwise. */
function stateCell(point: { partial: boolean }): string {
	return point.partial ? "partial" : "complete";
}

/** The scope line echoing the `--repo` / `--since` filters. */
function scopeLine(report: HistoryReport): string {
	const repo = report.scope.repo ? report.scope.repo : "all repos";
	const since = report.scope.since ? `since ${report.scope.since}` : "all time";
	return `scope: ${repo} · ${since}`;
}

/** The index path of a repo's series with consecutive duplicates collapsed (`4 → 7 → 7 → 3`). */
function indexPath(runs: readonly AuditRunPoint[]): string {
	const cells: string[] = [];
	for (const run of runs) {
		const cell = `${run.index}${run.partial ? " (partial)" : ""}`;
		if (cell !== cells[cells.length - 1]) cells.push(cell);
	}
	return cells.join(" → ");
}

/** Render the fixed-width sloppiness snapshot table into `lines`. */
function pushSnapshot(lines: string[], snapshot: readonly AuditSnapshotEntry[]): void {
	lines.push(`sloppiness snapshot (${snapshot.length}) · index 0–100, lower is better`);
	if (snapshot.length === 0) {
		lines.push("  (no audit runs recorded)");
		return;
	}
	const idWidth = Math.max(4, ...snapshot.map((e) => e.repo.length));
	lines.push(
		`  ${pad("repo", idWidth)}  ${padStart("index", 6)}  ${pad("state", 8)}  ${pad("Δ", 4)}  ${padStart("runs", 4)}  ${pad("scoring", 16)}  audited`,
	);
	for (const e of snapshot) {
		lines.push(
			`  ${pad(e.repo, idWidth)}  ${padStart(`${e.index}/100`, 6)}  ${pad(stateCell(e), 8)}  ${pad(deltaCell(e.indexDelta), 4)}  ${padStart(`${e.runs}`, 4)}  ${pad(e.scoringVersion, 16)}  ${e.auditedAt}`,
		);
	}
}

/** Render one repo's sloppiness series into `lines`. */
function pushRepo(lines: string[], repo: AuditRepoHistory): void {
	lines.push(`${repo.repo} · ${repo.runs.length} run${repo.runs.length === 1 ? "" : "s"}`);
	const auditedWidth = Math.max(7, ...repo.runs.map((r) => r.auditedAt.length));
	lines.push(
		`  ${pad("audited", auditedWidth)}  ${padStart("index", 6)}  ${pad("state", 8)}  scoring`,
	);
	for (const r of repo.runs) {
		lines.push(
			`  ${pad(r.auditedAt, auditedWidth)}  ${padStart(`${r.index}/100`, 6)}  ${pad(stateCell(r), 8)}  ${r.scoringVersion}`,
		);
	}
	lines.push(`  trend: ${indexPath(repo.runs)}`);
}

/** Render a history report as the default human-readable terminal dashboard. */
export function renderHistoryTerminal(report: HistoryReport): string {
	const lines = ["trellis report · sloppiness history", scopeLine(report), ""];
	pushSnapshot(lines, report.audits.snapshot);
	for (const repo of report.audits.repos) {
		lines.push("");
		pushRepo(lines, repo);
	}
	lines.push("");
	return lines.join("\n");
}

/** Escape a `|` so it doesn't break a markdown table cell. */
function cell(s: string): string {
	return s.replace(/\|/g, "\\|");
}

/** Render the markdown sloppiness snapshot table into `lines`. */
function pushMarkdownSnapshot(lines: string[], snapshot: readonly AuditSnapshotEntry[]): void {
	lines.push(`## Sloppiness snapshot (${snapshot.length})`, "");
	lines.push(
		"Index 0–100, **lower is better**; Δ is the index move vs the previous compatible run (positive = worse).",
		"",
	);
	if (snapshot.length === 0) {
		lines.push("_no audit runs recorded_", "");
		return;
	}
	lines.push(
		"| Repo | Index | State | Δ | Runs | Scoring | Audited |",
		"| --- | --- | --- | --- | --- | --- | --- |",
	);
	for (const e of snapshot) {
		lines.push(
			`| \`${cell(e.repo)}\` | ${e.index}/100 | ${stateCell(e)} | ${deltaCell(e.indexDelta)} | ${e.runs} | ${e.scoringVersion} | ${e.auditedAt} |`,
		);
	}
	lines.push("");
}

/** Render one repo's markdown sloppiness section: the compatible series plus its trend. */
function pushMarkdownRepo(lines: string[], repo: AuditRepoHistory): void {
	lines.push(
		`## \`${cell(repo.repo)}\` · ${repo.runs.length} run${repo.runs.length === 1 ? "" : "s"}`,
		"",
	);
	lines.push("| Audited | Index | State | Scoring |", "| --- | --- | --- | --- |");
	for (const r of repo.runs) {
		lines.push(`| ${r.auditedAt} | ${r.index}/100 | ${stateCell(r)} | ${r.scoringVersion} |`);
	}
	lines.push("", `Trend: ${indexPath(repo.runs)}`, "");
}

/** Render a history report as a PR/issue-ready markdown dashboard. */
export function renderHistoryMarkdown(report: HistoryReport): string {
	const lines = ["# Trellis history", "", scopeLine(report), ""];
	pushMarkdownSnapshot(lines, report.audits.snapshot);
	for (const repo of report.audits.repos) pushMarkdownRepo(lines, repo);
	return lines.join("\n");
}
