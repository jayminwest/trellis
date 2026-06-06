#!/usr/bin/env bun
/**
 * Thin commander entrypoint (SPEC §13.1). This surface parses args and shapes
 * output only — all behavior lives in the domain core under `src/`. The command
 * set below is the SPEC §12 surface; each action is a stub until its milestone
 * lands. Running with no command, or `--help`, prints the usage stub.
 */

import { Command } from "commander";
import { VERSION } from "../index.ts";

const NOT_IMPLEMENTED = "not yet implemented — see SPEC §14 milestones";

function stub(command: string): () => never {
	return () => {
		process.stderr.write(`trellis ${command}: ${NOT_IMPLEMENTED}\n`);
		process.exit(1);
	};
}

export function buildProgram(): Command {
	const program = new Command();

	program
		.name("trellis")
		.description("Agentic-readiness audit & sync for code repositories")
		.version(VERSION);

	program
		.command("audit")
		.argument("<repo-path>", "path to the repository to score")
		.description("score one repo; print scorecard")
		.option("--json", "emit machine-readable JSON")
		.option("--md", "emit a markdown report")
		.option("--no-cache", "force re-investigation (ignore cached findings)")
		.option("--rubric-version <v>", "pin the rubric version")
		.option("--canonical <v>", "pin the canonical standards version")
		.action(stub("audit"));

	program
		.command("drift")
		.argument("<repo-path>", "path to the repository to compare")
		.description("L1 canonical-config drift only")
		.action(stub("drift"));

	program
		.command("fleet")
		.description("audit every target in targets.yaml")
		.option("--targets <file>", "fleet declaration", "targets.yaml")
		.option("--json", "emit machine-readable JSON")
		.option("--md", "emit a markdown report")
		.action(stub("fleet"));

	program
		.command("report")
		.description("render history/dashboard from SQLite")
		.option("--repo <id>", "limit to one target")
		.option("--since <date>", "only runs since this date")
		.option("--json", "emit machine-readable JSON")
		.option("--md", "emit a markdown report")
		.action(stub("report"));

	program
		.command("rubric")
		.description("print the loaded rubric + version")
		.option("--validate", "validate rubric data invariants")
		.action(stub("rubric"));

	program
		.command("standards")
		.description("show canonical manifest + versions")
		.action(stub("standards"));

	return program;
}

if (import.meta.main) {
	await buildProgram().parseAsync(process.argv);
}
