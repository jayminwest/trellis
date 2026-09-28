/**
 * `trellis brand <repo-path>` — static os-eco CLI brand check
 * (docs/brand-standard.md). Thin per SPEC §13.1: it calls the core
 * {@link checkBrand} and shapes the three output variants.
 *
 * Findings are reported, not enforced: the default exit is `0` so existing
 * repos are never broken silently. `--fail-on findings` opts into exit `2`.
 */
import type { Command } from "commander";
import { Option } from "commander";
import { type BrandReport, checkBrand } from "../standards/index.ts";
import { emit, FailOnExit, type Rendered, resolveFormat } from "./output.ts";

/** Local options for the brand command, merged with the global format flags. */
interface BrandCliOptions {
	json?: boolean;
	md?: boolean;
	failOn?: string;
}

/** Register the `brand` subcommand on `program`. */
export function registerBrand(program: Command): void {
	program
		.command("brand")
		.argument("<repo-path>", "path to the repository to check")
		.description("static os-eco CLI brand check (separate, unscored)")
		.addOption(
			new Option("--fail-on <mode>", "exit non-zero on: findings|none (default: none)").choices([
				"findings",
				"none",
			]),
		)
		.action(function (this: Command, repoPath: string) {
			runBrand(repoPath, this.optsWithGlobals() as BrandCliOptions);
		});
}

function humanBrand(report: BrandReport): string {
	const lines = [
		`trellis brand · ${report.repo} · ${report.findings.length} findings / ${report.rules.length} rules`,
	];
	for (const finding of report.findings) lines.push(`  ${finding.rule}: ${finding.detail}`);
	return lines.join("\n");
}

function markdownBrand(report: BrandReport): string {
	const lines = [`# Brand check \`${report.repo}\``, ""];
	if (report.findings.length === 0) lines.push("All brand rules pass.");
	else {
		lines.push("| Rule | Finding |", "| --- | --- |");
		for (const finding of report.findings) lines.push(`| ${finding.rule} | ${finding.detail} |`);
	}
	lines.push("");
	return lines.join("\n");
}

/** Run the core brand check, emit it, then apply the opt-in exit-code policy. */
function runBrand(repoPath: string, opts: BrandCliOptions): void {
	const format = resolveFormat(opts);
	const report = checkBrand(repoPath);
	emit(format, {
		human: humanBrand(report),
		json: report,
		md: markdownBrand(report),
	} satisfies Rendered);
	if (opts.failOn === "findings" && report.findings.length > 0) {
		throw new FailOnExit([`brand findings detected (${report.findings.length})`]);
	}
}
