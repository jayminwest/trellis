/**
 * Markdown renderer (SPEC §6.3) — a scorecard sized for pasting into a PR or
 * issue. A headline (repo, level, pass-rate, coverage), the discovered app map,
 * a per-category table, and a compact N/A breakdown. Pure projection of the
 * {@link Report} plus the rubric's category membership (via {@link rollupByCategory});
 * it computes no scores of its own.
 */
import type { Rubric } from "../rubric/index.ts";
import { type CategoryRollup, pct, rollupByCategory, tally } from "./rollup.ts";
import type { Report } from "./types.ts";

/** One category table row: `counted/total` measured, with N/A and pass-rate. */
function categoryRow(c: CategoryRollup): string {
	return `| ${c.title} | ${c.counted}/${c.total} | ${c.noDetector} | ${c.notApplicable} | ${pct(c.passRate)} |`;
}

/** Render a report as a PR/issue-ready markdown scorecard. */
export function renderMarkdown(report: Report, rubric: Rubric): string {
	const rollups = rollupByCategory(report, rubric);
	const t = tally(report);
	const appPaths = Object.keys(report.apps);

	const lines: string[] = [
		`# Agentic-readiness scorecard — \`${report.repo}\``,
		"",
		`**Level ${report.level} / 5** · pass-rate **${pct(report.passRate)}** · coverage **${pct(report.coverage)}**`,
		"",
		`- Rubric \`${report.rubricVersion}\` · commit \`${report.commit}\` · scored ${report.scoredAt}`,
		`- Apps (${appPaths.length}): ${appPaths.map((p) => `\`${p}\``).join(", ")}`,
		`- Measured ${t.counted}/${t.total} criteria · ${t.noDetector} no-detector · ${t.notApplicable} not-applicable`,
		"",
		"| Category | Measured | No-det | N/A | Pass-rate |",
		"| --- | ---: | ---: | ---: | ---: |",
	];
	for (const c of rollups) lines.push(categoryRow(c));
	lines.push("");
	return lines.join("\n");
}
