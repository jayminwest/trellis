/**
 * History dashboard renderers (SPEC §11) — the terminal and markdown projections
 * of a {@link HistoryReport}. Pure functions over the report: a fixed-width fleet
 * snapshot plus per-repo run series, the latest §11 delta (with rubric-version
 * attribution), and the moved-criterion trends. The JSON projection is the
 * {@link HistoryReport} itself (the CLI serializes it directly), so there is no
 * separate JSON renderer here.
 *
 * Both views compute nothing — every level, rate, delta, and transition comes
 * straight off the report. No ANSI, so they compose with pipes and CI logs.
 */

import type {
	ChangesSinceLastRun,
	CriterionSnapshot,
	CriterionTransition,
} from "../report/index.ts";
import { pct } from "../report/index.ts";
import type {
	CriterionTrend,
	HistoryReport,
	RepoHistory,
	SnapshotEntry,
	TrendPoint,
} from "./dashboard.ts";

/** Right-pad `s` to `width` for fixed-width columns. */
function pad(s: string, width: number): string {
	return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/** Left-pad `s` to `width` for right-aligned numeric columns. */
function padStart(s: string, width: number): string {
	return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

/** A signed level move: `new` for a first run, `+1` / `0` / `-1` otherwise. */
function deltaCell(levelDelta: number | null): string {
	if (levelDelta === null) return "new";
	return levelDelta > 0 ? `+${levelDelta}` : `${levelDelta}`;
}

/** A criterion snapshot as a compact cell: `n/d` when counted, the N/A kind otherwise, `—` when absent. */
function snapCell(snap: CriterionSnapshot | null): string {
	if (snap === null) return "—";
	return snap.naKind === null ? `${snap.numerator}/${snap.denominator}` : snap.naKind;
}

/** A trend point as a compact cell: `n/d` when counted, the N/A kind otherwise. */
function pointCell(point: TrendPoint): string {
	return point.naKind === null ? `${point.numerator}/${point.denominator}` : point.naKind;
}

/** The trend's value path with consecutive duplicates collapsed (`1/1 → 0/1 → 1/1`). */
function trendPath(trend: CriterionTrend): string {
	const cells: string[] = [];
	for (const point of trend.points) {
		const cell = pointCell(point);
		if (cell !== cells[cells.length - 1]) cells.push(cell);
	}
	return cells.join(" → ");
}

/** The attribution phrase for a §11 delta, naming the rubric move when versions differ. */
function attribution(delta: ChangesSinceLastRun, currentRubric: string): string {
	return delta.attribution === "possibly-rubric"
		? `possibly rubric-driven: ${delta.previousRubricVersion} → ${currentRubric}`
		: "code change";
}

/** One transition line: `[kind] criterion: before → after`. */
function transitionLine(t: CriterionTransition): string {
	return `[${t.kind}] ${t.criterion}: ${snapCell(t.before)} → ${snapCell(t.after)}`;
}

/** The scope line echoing the `--repo` / `--since` filters. */
function scopeLine(report: HistoryReport): string {
	const repo = report.scope.repo ? report.scope.repo : "all repos";
	const since = report.scope.since ? `since ${report.scope.since}` : "all time";
	return `scope: ${repo} · ${since}`;
}

/** Render the fixed-width fleet snapshot table into `lines`. */
function pushSnapshot(lines: string[], fleet: readonly SnapshotEntry[]): void {
	lines.push(`fleet snapshot (${fleet.length})`);
	if (fleet.length === 0) {
		lines.push("  (no runs recorded)");
		return;
	}
	const idWidth = Math.max(4, ...fleet.map((e) => e.repo.length));
	lines.push(
		`  ${pad("repo", idWidth)}  ${pad("level", 5)}  ${padStart("pass", 5)}  ${padStart("cov", 5)}  ${pad("Δ", 4)}  ${padStart("runs", 4)}  scored`,
	);
	for (const e of fleet) {
		lines.push(
			`  ${pad(e.repo, idWidth)}  ${pad(`L${e.level}`, 5)}  ${padStart(pct(e.passRate), 5)}  ${padStart(pct(e.coverage), 5)}  ${pad(deltaCell(e.levelDelta), 4)}  ${padStart(`${e.runs}`, 4)}  ${e.scoredAt}`,
		);
	}
}

/** Render one repo's run series, latest §11 delta, and moved-criterion trends into `lines`. */
function pushRepo(lines: string[], repo: RepoHistory): void {
	lines.push(`${repo.repo} · ${repo.runs.length} run${repo.runs.length === 1 ? "" : "s"}`);
	const scoredWidth = Math.max(6, ...repo.runs.map((r) => r.scoredAt.length));
	lines.push(
		`  ${pad("scored", scoredWidth)}  ${pad("level", 5)}  ${padStart("pass", 5)}  ${padStart("cov", 5)}  rubric`,
	);
	for (const r of repo.runs) {
		lines.push(
			`  ${pad(r.scoredAt, scoredWidth)}  ${pad(`L${r.level}`, 5)}  ${padStart(pct(r.passRate), 5)}  ${padStart(pct(r.coverage), 5)}  ${r.rubricVersion}`,
		);
	}

	const delta = repo.changesSinceLastRun;
	if (delta) {
		const currentRubric =
			repo.runs[repo.runs.length - 1]?.rubricVersion ?? delta.previousRubricVersion;
		lines.push("");
		lines.push(`  changes since ${delta.previousScoredAt} (${attribution(delta, currentRubric)})`);
		lines.push(`    net level ${deltaCell(delta.netLevelMove)}`);
		if (delta.transitions.length === 0) {
			lines.push("    (no per-criterion changes)");
		} else {
			for (const t of delta.transitions) lines.push(`    ${transitionLine(t)}`);
		}
	}

	if (repo.trends.length > 0) {
		lines.push("");
		lines.push(`  trends (${repo.trends.length} moved)`);
		for (const trend of repo.trends) lines.push(`    ${trend.criterion}: ${trendPath(trend)}`);
	}
}

/** Render a history report as the default human-readable terminal dashboard. */
export function renderHistoryTerminal(report: HistoryReport): string {
	const lines = [`trellis report · rubric ${report.rubricVersion}`, scopeLine(report), ""];
	pushSnapshot(lines, report.fleet);
	for (const repo of report.repos) {
		lines.push("");
		pushRepo(lines, repo);
	}
	return lines.join("\n");
}

/** Escape a `|` so it doesn't break a markdown table cell. */
function cell(s: string): string {
	return s.replace(/\|/g, "\\|");
}

/** Render the markdown fleet-snapshot table into `lines`. */
function pushMarkdownSnapshot(lines: string[], fleet: readonly SnapshotEntry[]): void {
	lines.push(`## Fleet snapshot (${fleet.length})`, "");
	if (fleet.length === 0) {
		lines.push("_no runs recorded_", "");
		return;
	}
	lines.push(
		"| Repo | Level | Pass | Coverage | Δ | Runs | Scored |",
		"| --- | --- | --- | --- | --- | --- | --- |",
	);
	for (const e of fleet) {
		lines.push(
			`| \`${e.repo}\` | L${e.level} | ${pct(e.passRate)} | ${pct(e.coverage)} | ${deltaCell(e.levelDelta)} | ${e.runs} | ${e.scoredAt} |`,
		);
	}
	lines.push("");
}

/** Render one repo's markdown §11 delta section (table or "no changes") into `lines`. */
function pushMarkdownDelta(lines: string[], repo: RepoHistory): void {
	const delta = repo.changesSinceLastRun;
	if (!delta) return;
	const currentRubric =
		repo.runs[repo.runs.length - 1]?.rubricVersion ?? delta.previousRubricVersion;
	lines.push(
		`### Changes since ${delta.previousScoredAt}`,
		"",
		`Net level **${deltaCell(delta.netLevelMove)}** · ${attribution(delta, currentRubric)}`,
		"",
	);
	if (delta.transitions.length === 0) {
		lines.push("_no per-criterion changes_", "");
		return;
	}
	lines.push("| Criterion | Kind | Before | After |", "| --- | --- | --- | --- |");
	for (const t of delta.transitions) {
		lines.push(
			`| \`${cell(t.criterion)}\` | ${t.kind} | ${snapCell(t.before)} | ${snapCell(t.after)} |`,
		);
	}
	lines.push("");
}

/** Render one repo's markdown section: run series, §11 delta, and moved-criterion trends. */
function pushMarkdownRepo(lines: string[], repo: RepoHistory): void {
	lines.push(
		`## \`${repo.repo}\` · ${repo.runs.length} run${repo.runs.length === 1 ? "" : "s"}`,
		"",
	);
	lines.push("| Scored | Level | Pass | Coverage | Rubric |", "| --- | --- | --- | --- | --- |");
	for (const r of repo.runs) {
		lines.push(
			`| ${r.scoredAt} | L${r.level} | ${pct(r.passRate)} | ${pct(r.coverage)} | ${r.rubricVersion} |`,
		);
	}
	lines.push("");

	pushMarkdownDelta(lines, repo);

	if (repo.trends.length > 0) {
		lines.push(`### Trends (${repo.trends.length} moved)`, "");
		for (const trend of repo.trends) {
			lines.push(`- \`${cell(trend.criterion)}\`: ${trendPath(trend)}`);
		}
		lines.push("");
	}
}

/** Render a history report as a PR/issue-ready markdown dashboard. */
export function renderHistoryMarkdown(report: HistoryReport): string {
	const lines = [
		"# Trellis history",
		"",
		`rubric ${report.rubricVersion} · ${scopeLine(report)}`,
		"",
	];
	pushMarkdownSnapshot(lines, report.fleet);
	for (const repo of report.repos) pushMarkdownRepo(lines, repo);
	return lines.join("\n");
}
