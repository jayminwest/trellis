/**
 * `trellis fleet` — audit every target in a `targets.yaml` (SPEC §6.5, §12).
 *
 * Thin per SPEC §13.1: load + validate the fleet declaration, call the core
 * {@link runFleet} (which audits + drifts each target, persists every run to the
 * central history, and computes per-repo level deltas), then shape the three
 * output variants. Each target's audit honors its `allowedDeltas`, `skip`, and
 * `osecoDetectors`; a missing path or a per-target audit failure is isolated into
 * an error row without aborting the fleet. `--no-cache` forces re-investigation;
 * `--db` overrides the central DB; `TRELLIS_PI_BIN` overrides the `pi` binary.
 * Exit is always `0` here — the `--fail-on` contract lands with the SDK exit-code
 * step (trellis-28a5).
 */
import type { Command } from "commander";
import { Option } from "commander";
import {
	loadFleet,
	renderFleetMarkdown,
	renderFleetTerminal,
	runFleet,
	TARGETS_FILE,
	TargetsError,
} from "../fleet/index.ts";
import { loadRubric, type Rubric, RubricError } from "../rubric/index.ts";
import { openStore } from "../store/index.ts";
import { CliError, EXIT, emit, type Rendered, resolveFormat } from "./output.ts";

/** Local options for the fleet command, merged with the global format flags. */
interface FleetCliOptions {
	json?: boolean;
	md?: boolean;
	targets?: string;
	cache?: boolean;
	/** SQLite history path; defaults to `TRELLIS_DB` env or `~/.trellis/trellis.db`. */
	db?: string;
}

/** Register the `fleet` subcommand on `program`. */
export function registerFleet(program: Command): void {
	program
		.command("fleet")
		.description("audit every target in targets.yaml")
		.option("--targets <file>", "fleet declaration", TARGETS_FILE)
		.option("--no-cache", "force re-investigation (ignore cached findings)")
		.addOption(new Option("--db <path>", "SQLite history path").hideHelp())
		.action(function (this: Command) {
			return runFleetCommand(this.optsWithGlobals() as FleetCliOptions);
		});
}

/** Load the fleet, run every target through core, and emit the chosen output variant. */
async function runFleetCommand(opts: FleetCliOptions): Promise<void> {
	const format = resolveFormat(opts);
	const fleet = loadFleetOrThrow(opts.targets ?? TARGETS_FILE);
	const rubric = loadRubricOrThrow();
	const piBin = process.env.TRELLIS_PI_BIN?.trim();
	const store = openStore(opts.db);
	try {
		const report = await runFleet(fleet, {
			store,
			rubric,
			...(opts.cache === false ? { noCache: true } : {}),
			...(piBin ? { piBin } : {}),
		});
		emit(format, {
			human: renderFleetTerminal(report),
			json: report,
			md: renderFleetMarkdown(report),
		} satisfies Rendered);
	} finally {
		store.close();
	}
}

/** Load the fleet, converting a {@link TargetsError} into a {@link CliError}. */
function loadFleetOrThrow(file: string): ReturnType<typeof loadFleet> {
	try {
		return loadFleet(file);
	} catch (error) {
		if (error instanceof TargetsError) throw new CliError(error.message, EXIT.ERROR);
		throw error;
	}
}

/** Load the rubric once for the whole fleet, converting a {@link RubricError} into a {@link CliError}. */
function loadRubricOrThrow(): Rubric {
	try {
		return loadRubric();
	} catch (error) {
		if (error instanceof RubricError) {
			throw new CliError(error.message, EXIT.ERROR, { id: error.id, file: error.file });
		}
		throw error;
	}
}
