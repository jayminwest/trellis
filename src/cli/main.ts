#!/usr/bin/env bun
/**
 * Thin commander entrypoint (SPEC §13.1). This surface parses args and shapes
 * output only — all behavior lives in the domain core under `src/`. The command
 * set below is the full SPEC §12 surface, each registered from its own module.
 * Global `--json` / `--md` flags select machine/report output (human terminal
 * output is the default), and every handled failure routes through
 * {@link CliError} for consistent rendering and a stable exit code.
 */

import { Command } from "commander";
import { VERSION } from "../index.ts";
import { registerAudit } from "./audit.ts";
import { registerCompare } from "./compare.ts";
import { registerDrift } from "./drift.ts";
import { registerFleet } from "./fleet.ts";
import { registerGuide } from "./guide.ts";
import {
	CliError,
	EXIT,
	FailOnExit,
	type OutputFormat,
	renderError,
	resolveFormat,
} from "./output.ts";
import { registerReport } from "./report.ts";
import { registerStandards } from "./standards.ts";

export function buildProgram(): Command {
	const program = new Command();

	program
		.name("trellis")
		.description(
			"Deterministic sloppiness audit for TypeScript workspaces (0-100, lower is better)",
		)
		.version(VERSION)
		.option("--json", "emit machine-readable JSON")
		.option("--md", "emit a markdown report");

	registerAudit(program);
	registerCompare(program);
	registerDrift(program);
	registerFleet(program);
	registerGuide(program);
	registerReport(program);
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
		// A tripped --fail-on policy: the report is already on stdout, so just note
		// the reasons on stderr and surface the non-zero code (SPEC §12).
		if (error instanceof FailOnExit) {
			for (const reason of error.reasons) process.stderr.write(`trellis: ${reason}\n`);
			return error.code;
		}
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
	process.exitCode = await run(process.argv);
}
