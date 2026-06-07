/**
 * Markdown renderer (SPEC §6.3) — the persisted audit FILE. Unlike the brief
 * terminal scorecard (level banner + per-category table), this view renders
 * *everything the audit looked at and graded*: every one of the §6.2 criteria
 * with its verdict / score / rationale (grouped by category, failing first), the
 * gate criteria that tripped the `--fail-on` contract, the canonical-config
 * drift, and the per-criterion delta since the prior run. A pure projection of
 * the {@link Report} plus the rubric's category membership; it computes no scores
 * of its own (numbers come from {@link rollupByCategory} / {@link projectCriteria}).
 */
import type { Rubric } from "../rubric/index.ts";
import type { DriftReport, DriftState, FileDrift } from "../standards/index.ts";
import { failingGateIds } from "./assess.ts";
import {
	type CategoryRollup,
	type CriterionLine,
	pct,
	projectCriteria,
	rollupByCategory,
	tally,
} from "./rollup.ts";
import type { ChangesSinceLastRun, CriterionSnapshot, Report } from "./types.ts";

/** Escape a free-text value for a single markdown table cell (pipes, newlines). */
function cell(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** One category table row: `counted/total` measured, with N/A and pass-rate. */
function categoryRow(c: CategoryRollup): string {
	return `| ${c.title} | ${c.counted}/${c.total} | ${c.noDetector} | ${c.notApplicable} | ${pct(c.passRate)} |`;
}

/** A criterion's score column: `numerator/denominator`, or `n/a` when N/A. */
function scoreOf(line: CriterionLine): string {
	return line.numerator === null ? "n/a" : `${line.numerator}/${line.denominator}`;
}

/** A criterion's verdict label, flagging a tripped gate. */
function verdictOf(line: CriterionLine): string {
	return line.gateFailed ? `${line.status} (gate)` : line.status;
}

/** One detailed criterion table row. */
function criterionRow(line: CriterionLine): string {
	return `| \`${line.id}\` | ${verdictOf(line)} | ${scoreOf(line)} | ${cell(line.rationale)} |`;
}

/** Render the per-category detail tables (every criterion, failing first). */
function criteriaSection(report: Report, rubric: Rubric): string[] {
	const lines: string[] = ["## Criteria", ""];
	for (const category of projectCriteria(report, rubric)) {
		lines.push(`### ${category.title}`, "");
		if (category.lines.length === 0) {
			lines.push("_No criteria measured in this category._", "");
			continue;
		}
		lines.push("| Criterion | Verdict | Score | Rationale |", "| --- | --- | ---: | --- |");
		for (const line of category.lines) lines.push(criterionRow(line));
		lines.push("");
	}
	return lines;
}

/** Render the failing-gate callout (SPEC §3.3, §12), omitted when none tripped. */
function gateSection(report: Report, rubric: Rubric): string[] {
	const gates = failingGateIds(report, rubric);
	if (gates.length === 0) return [];
	const lines: string[] = [
		"## Gate criteria failing",
		"",
		"Category-floor criteria that were measured and did not fully pass:",
		"",
	];
	for (const id of gates) {
		const entry = report.criteria[id];
		lines.push(`- \`${id}\`${entry ? ` — ${cell(entry.rationale)}` : ""}`);
	}
	lines.push("");
	return lines;
}

/** A drift summary line: per-state counts in `DRIFT_STATES` order. */
function driftSummaryLine(summary: Record<DriftState, number>): string {
	const order: DriftState[] = ["match", "allowed-delta", "drift", "missing", "extra"];
	return order.map((state) => `${state} ${summary[state]}`).join(" · ");
}

/** One drift file table row. */
function driftRow(file: FileDrift): string {
	return `| \`${file.path}\` | ${file.state} | ${file.version} | ${file.matcher} | ${file.divergences.length} |`;
}

/** Render canonical-config drift (SPEC §10), omitted when no comparison ran. */
function driftSection(drift: DriftReport | undefined): string[] {
	if (drift === undefined) return [];
	const lines: string[] = [
		`## Canonical-config drift — \`${drift.canonicalVersion}\``,
		"",
		`- ${driftSummaryLine(drift.summary)}`,
		"",
		"| File | State | Version | Matcher | Divergences |",
		"| --- | --- | --- | --- | ---: |",
	];
	for (const file of drift.files) lines.push(driftRow(file));
	lines.push("");
	for (const file of drift.files) {
		if (file.divergences.length === 0) continue;
		lines.push(`### \`${file.path}\` divergences (${file.state})`, "");
		for (const d of file.divergences) {
			lines.push(`- \`${d.path || "(file)"}\` (${d.kind}): ${cell(d.detail)}`);
		}
		lines.push("");
	}
	return lines;
}

/** Render one transition snapshot (`2/3`, `n/a (no-detector)`, or `—` when absent). */
function snapshotCell(snap: CriterionSnapshot | null): string {
	if (snap === null) return "—";
	const score = snap.numerator === null ? "n/a" : `${snap.numerator}/${snap.denominator}`;
	return snap.naKind ? `${score} (${snap.naKind})` : `${snap.status} ${score}`;
}

/** Render the per-criterion delta since the prior run (SPEC §11), omitted when none. */
function changesSection(changes: ChangesSinceLastRun | undefined): string[] {
	if (changes === undefined) return [];
	const move = changes.netLevelMove >= 0 ? `+${changes.netLevelMove}` : `${changes.netLevelMove}`;
	const lines: string[] = [
		"## Changes since last run",
		"",
		`- Previous: Level ${changes.previousLevel} · commit \`${changes.previousCommit}\` · rubric \`${changes.previousRubricVersion}\` · scored ${changes.previousScoredAt}`,
		`- Net level move: ${move} (attribution: ${changes.attribution})`,
		"",
	];
	if (changes.transitions.length === 0) {
		lines.push("_No per-criterion changes._", "");
		return lines;
	}
	lines.push("| Criterion | Move | Before | After |", "| --- | --- | --- | --- |");
	for (const t of changes.transitions) {
		lines.push(
			`| \`${t.criterion}\` | ${t.kind} | ${snapshotCell(t.before)} | ${snapshotCell(t.after)} |`,
		);
	}
	lines.push("");
	return lines;
}

/**
 * Render a report as the full, persisted markdown audit document. The headline
 * and per-category summary table mirror the terminal view; everything below it
 * (gates, criteria detail, drift, changes) is detail the terminal view omits.
 */
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

	lines.push(...gateSection(report, rubric));
	lines.push(...criteriaSection(report, rubric));
	lines.push(...driftSection(report.drift));
	lines.push(...changesSection(report.changesSinceLastRun));

	return lines.join("\n");
}
