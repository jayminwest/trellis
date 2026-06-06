/**
 * `trellis rubric [--validate]` — the first end-to-end command (SPEC §14.1).
 *
 * Thin per SPEC §13.1: it loads the rubric via the core loader (which runs every
 * load-time invariant), folds it with the core `summarizeRubric`, and shapes the
 * three output variants. It computes nothing itself. `--validate` is the
 * invariant-checking mode — a {@link RubricError} from the loader becomes a
 * {@link CliError} that renders precisely (id + source file) and exits non-zero.
 */
import { type Command, Option } from "commander";
import { loadRubric, RubricError } from "../rubric/loader.ts";
import { type RubricSummary, summarizeRubric } from "../rubric/summary.ts";
import { logger } from "./logger.ts";
import { CliError, EXIT, emit, type Rendered, resolveFormat } from "./output.ts";

/** Local options for the rubric command, merged with the global format flags. */
interface RubricOptions {
	validate?: boolean;
	json?: boolean;
	md?: boolean;
	/** Hidden: load an alternate rubric directory (used by tests/fixtures). */
	rubricDir?: string;
}

/** Register the `rubric` subcommand on `program`. */
export function registerRubric(program: Command): void {
	program
		.command("rubric")
		.description("print the loaded rubric + version")
		.option("--validate", "validate rubric data invariants")
		.addOption(new Option("--rubric-dir <path>", "load an alternate rubric directory").hideHelp())
		.action(function (this: Command) {
			runRubric(this.optsWithGlobals() as RubricOptions);
		});
}

/** Load + summarize the rubric, then emit it (or a validation result). */
function runRubric(opts: RubricOptions): void {
	const format = resolveFormat(opts);
	const summary = loadSummary(opts.rubricDir);
	if (opts.validate) {
		logger.debug({ rubricVersion: summary.rubricVersion }, "rubric invariants passed");
		emit(format, renderValidation(summary));
		return;
	}
	emit(format, renderSummary(summary));
}

/** Load + summarize, converting a loader {@link RubricError} into a {@link CliError}. */
function loadSummary(dir: string | undefined): RubricSummary {
	try {
		return summarizeRubric(loadRubric(dir));
	} catch (error) {
		if (error instanceof RubricError) {
			throw new CliError(error.message, EXIT.ERROR, { id: error.id, file: error.file });
		}
		throw error;
	}
}

/** Render the rubric summary as human text / JSON / markdown. */
function renderSummary(summary: RubricSummary): Rendered {
	return {
		human: humanSummary(summary),
		json: summary,
		md: markdownSummary(summary),
	};
}

/** Render the `--validate` result: the summary plus an explicit `valid` flag. */
function renderValidation(summary: RubricSummary): Rendered {
	return {
		human: `${humanSummary(summary)}\n✓ rubric valid (${summary.criterionCount} criteria across ${summary.categoryCount} categories)`,
		json: { valid: true, ...summary },
		md: `${markdownSummary(summary)}\n\n✓ **rubric valid** — ${summary.criterionCount} criteria across ${summary.categoryCount} categories\n`,
	};
}

/** Format a level histogram as `L1:3 L2:1 …`, omitting empty levels. */
function levelDigest(levels: RubricSummary["categories"][number]["levels"]): string {
	const parts: string[] = [];
	for (const level of [1, 2, 3, 4, 5] as const) {
		const count = levels[level];
		if (count > 0) parts.push(`L${level}:${count}`);
	}
	return parts.join(" ") || "—";
}

function humanSummary(summary: RubricSummary): string {
	const lines = [
		`trellis rubric @ ${summary.rubricVersion}`,
		`${summary.criterionCount} criteria across ${summary.categoryCount} categories`,
		"",
	];
	for (const category of summary.categories) {
		lines.push(
			`  ${category.id}  (${category.criterionCount}: ${category.repo} repo / ${category.app} app)`,
		);
		lines.push(`    levels: ${levelDigest(category.levels)}   gate: ${category.gate ?? "—"}`);
	}
	return lines.join("\n");
}

function markdownSummary(summary: RubricSummary): string {
	const lines = [
		`# trellis rubric \`${summary.rubricVersion}\``,
		"",
		`**${summary.criterionCount}** criteria across **${summary.categoryCount}** categories.`,
		"",
		"| Category | Criteria | Repo | App | Levels | Gate |",
		"| --- | ---: | ---: | ---: | --- | --- |",
	];
	for (const category of summary.categories) {
		lines.push(
			`| ${category.id} | ${category.criterionCount} | ${category.repo} | ${category.app} | ${levelDigest(category.levels)} | ${category.gate ?? "—"} |`,
		);
	}
	return lines.join("\n");
}
