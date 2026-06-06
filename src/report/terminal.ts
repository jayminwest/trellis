/**
 * Terminal renderer (SPEC §6.3) — the default human scorecard. A level banner
 * with pass-rate/coverage, the discovered app map, a fixed-width per-category
 * table, and the whole-run N/A breakdown. Pure text (no ANSI — composes cleanly
 * with pipes and CI logs); all numbers come from {@link rollupByCategory} /
 * {@link tally} so this view never disagrees with the markdown/JSON ones.
 */
import type { Rubric } from "../rubric/index.ts";
import { pct, rollupByCategory, tally } from "./rollup.ts";
import type { Report } from "./types.ts";

/** Right-pad `s` to `width` for fixed-width columns. */
function pad(s: string, width: number): string {
	return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/** Left-pad `s` to `width` for right-aligned numeric columns. */
function padStart(s: string, width: number): string {
	return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

/** Render a report as the default human-readable terminal scorecard. */
export function renderTerminal(report: Report, rubric: Rubric): string {
	const rollups = rollupByCategory(report, rubric);
	const t = tally(report);
	const appPaths = Object.keys(report.apps);

	const lines: string[] = [
		`trellis · ${report.repo} @ ${report.commit}`,
		`Level ${report.level}/5   pass-rate ${pct(report.passRate)}   coverage ${pct(report.coverage)}`,
		`rubric ${report.rubricVersion}   scored ${report.scoredAt}`,
		"",
		`apps (${appPaths.length}): ${appPaths.join(", ")}`,
		"",
	];

	const nameWidth = Math.max(8, ...rollups.map((c) => c.title.length));
	lines.push(
		`  ${pad("category", nameWidth)}  ${padStart("meas", 7)}  ${padStart("no-det", 6)}  ${padStart("n/a", 5)}  ${padStart("pass", 5)}`,
	);
	for (const c of rollups) {
		lines.push(
			`  ${pad(c.title, nameWidth)}  ${padStart(`${c.counted}/${c.total}`, 7)}  ${padStart(`${c.noDetector}`, 6)}  ${padStart(`${c.notApplicable}`, 5)}  ${padStart(pct(c.passRate), 5)}`,
		);
	}

	lines.push("");
	lines.push(
		`measured ${t.counted}/${t.total} · ${t.noDetector} no-detector · ${t.notApplicable} not-applicable`,
	);
	return lines.join("\n");
}
