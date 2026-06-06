#!/usr/bin/env bun
/**
 * Thin commander entrypoint (SPEC §13.1). This surface parses args and shapes
 * output only — all behavior lives in the domain core under `src/`. The command
 * set below is the SPEC §12 surface; `rubric` is the first end-to-end command,
 * the rest are stubs until their milestone lands. Global `--json` / `--md` flags
 * select machine/report output (human terminal output is the default), and every
 * handled failure routes through {@link CliError} for consistent rendering and a
 * stable exit code.
 */

import { Command } from "commander";
import { VERSION } from "../index.ts";
import { registerAudit } from "./audit.ts";
import { registerDrift } from "./drift.ts";
import { registerFleet } from "./fleet.ts";
import { CliError, EXIT, type OutputFormat, renderError, resolveFormat } from "./output.ts";
import { registerRubric } from "./rubric.ts";
import { registerStandards } from "./standards.ts";

const NOT_IMPLEMENTED = "not yet implemented — see SPEC §14 milestones";

function stub(command: string): () => never {
	return () => {
		throw new CliError(`${command}: ${NOT_IMPLEMENTED}`, EXIT.ERROR);
	};
}

export function buildProgram(): Command {
	const program = new Command();

	program
		.name("trellis")
		.description("Agentic-readiness audit & sync for code repositories")
		.version(VERSION)
		.option("--json", "emit machine-readable JSON")
		.option("--md", "emit a markdown report");

	registerAudit(program);
	registerDrift(program);
	registerFleet(program);

	program
		.command("report")
		.description("render history/dashboard from SQLite")
		.option("--repo <id>", "limit to one target")
		.option("--since <date>", "only runs since this date")
		.action(stub("report"));

	registerRubric(program);
	registerStandards(program);

	return program;
}

/**
 * Best-effort output format from raw argv, used only to render a thrown
 * {@link CliError} in the caller's chosen format before commander has parsed.
 */
function formatFromArgv(argv: string[]): OutputFormat {
	try {
		return resolveFormat({ json: argv.includes("--json"), md: argv.includes("--md") });
	} catch {
		return "human";
	}
}

/** Parse argv and run; translate handled failures into a stable exit code. */
export async function run(argv: string[]): Promise<number> {
	const program = buildProgram();
	program.exitOverride();
	try {
		await program.parseAsync(argv);
		return EXIT.OK;
	} catch (error) {
		if (error instanceof CliError) {
			return renderError(error, formatFromArgv(argv));
		}
		// commander throws a CommanderError for --help/--version/usage errors; it
		// has already written its own output, so just surface its exit code.
		if (error && typeof error === "object" && "exitCode" in error) {
			return Number((error as { exitCode: unknown }).exitCode) || EXIT.OK;
		}
		throw error;
	}
}

if (import.meta.main) {
	process.exit(await run(process.argv));
}
