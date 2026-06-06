/**
 * `trellis audit <repo-path>` — the det-only end-to-end audit (SPEC §12, §14
 * milestone 3). Thin per SPEC §13.1: it loads the rubric once, calls the core
 * {@link auditRepo} pipeline, and shapes the three output variants. It computes
 * nothing itself — the level, scores, and per-criterion entries all come from
 * core.
 *
 * Agent-discovery criteria are graded by the investigation layer (SPEC §7.3):
 * each referenced area is resolved once via the central cache (`--no-cache`
 * forces re-investigation) backed by the Pi provider, and a missing/incompatible
 * Pi degrades those criteria to `no-detector` without crashing. Each run persists
 * to the central SQLite history (SPEC §6.4) — which also backs the investigation
 * cache — unless `--no-persist` is given; `--db` overrides the central DB
 * location. `TRELLIS_PI_BIN` overrides the `pi` binary the provider spawns.
 * `--rubric-version` is informational for now; `--canonical <v>` opts the run into
 * canonical-config drift (SPEC §10), folding the per-file result into
 * `report.drift` — standalone, so allowed deltas are empty (the fleet supplies
 * per-repo deltas later, trellis-6eb1). Exit is always `0` in this milestone —
 * the `--fail-on` contract arrives with the SDK exit-code step (trellis-28a5).
 */
import { basename, resolve } from "node:path";
import type { Command } from "commander";
import { Option } from "commander";
import { auditRepo, renderMarkdown, renderTerminal } from "../report/index.ts";
import { loadRubric, type Rubric, RubricError } from "../rubric/index.ts";
import { openStore, storedReport } from "../store/index.ts";
import { CliError, EXIT, emit, type Rendered, resolveFormat } from "./output.ts";

/** Local options for the audit command, merged with the global format flags. */
interface AuditCliOptions {
	json?: boolean;
	md?: boolean;
	cache?: boolean;
	rubricVersion?: string;
	canonical?: string;
	/** SQLite history path; defaults to `TRELLIS_DB` env or `~/.trellis/trellis.db`. */
	db?: string;
	/** Skip persisting this run to the central history. */
	persist?: boolean;
	/** Hidden: load an alternate rubric directory (used by tests/fixtures). */
	rubricDir?: string;
}

/** Register the `audit` subcommand on `program`. */
export function registerAudit(program: Command): void {
	program
		.command("audit")
		.argument("<repo-path>", "path to the repository to score")
		.description("score one repo; print scorecard")
		.option("--no-cache", "force re-investigation (ignore cached findings)")
		.option("--rubric-version <v>", "pin the rubric version (informational)")
		.option("--canonical <v>", "pin the canonical standards version")
		.option("--db <path>", "SQLite history path (default: $TRELLIS_DB or ~/.trellis/trellis.db)")
		.option("--no-persist", "do not write this run to the central history")
		.addOption(new Option("--rubric-dir <path>", "load an alternate rubric directory").hideHelp())
		.action(function (this: Command, repoPath: string) {
			return runAudit(repoPath, this.optsWithGlobals() as AuditCliOptions);
		});
}

/** Load the rubric, run the core audit, and emit the chosen output variant. */
async function runAudit(repoPath: string, opts: AuditCliOptions): Promise<void> {
	const format = resolveFormat(opts);
	const rubric = loadRubricOrThrow(opts.rubricDir);
	// The store doubles as the run history and the investigation cache; opening it
	// also backs `--no-cache`. With `--no-persist` we touch no DB at all, so the
	// investigation runs uncached (still degrading gracefully if Pi is absent).
	const store = opts.persist === false ? null : openStore(opts.db);
	const piBin = process.env.TRELLIS_PI_BIN?.trim();
	try {
		// Read this repo's prior run before persisting the new one so the embedded
		// §11 delta reflects it (repo id is the path basename, as auditRepo defaults).
		const previous = store?.latestRun(basename(resolve(repoPath))) ?? null;
		const report = await auditRepo(repoPath, {
			rubric,
			...(opts.rubricVersion ? { rubricVersion: opts.rubricVersion } : {}),
			previousRun: previous ? storedReport(previous) : null,
			investigation: {
				...(store ? { cache: store } : {}),
				noCache: opts.cache === false,
				...(piBin ? { investigateOpts: { piBin } } : {}),
			},
			...(opts.canonical ? { canonical: { canonicalVersion: opts.canonical } } : {}),
		});
		store?.insertRun(report);
		emit(format, {
			human: renderTerminal(report, rubric),
			json: report,
			md: renderMarkdown(report, rubric),
		} satisfies Rendered);
	} finally {
		store?.close();
	}
}

/** Load the rubric, converting a loader {@link RubricError} into a {@link CliError}. */
function loadRubricOrThrow(dir: string | undefined): Rubric {
	try {
		return loadRubric(dir);
	} catch (error) {
		if (error instanceof RubricError) {
			throw new CliError(error.message, EXIT.ERROR, { id: error.id, file: error.file });
		}
		throw error;
	}
}
