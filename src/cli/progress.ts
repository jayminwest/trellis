/**
 * CLI progress rendering — the surface half of the deterministic audit core's
 * progress contract (SPEC §12, trellis-9a88). The core
 * ({@link import("../audit/index.ts").auditWorkspace}) emits structured,
 * bounded {@link AuditEvent}s; this module turns them into human progress on
 * **stderr**, keeping stdout reserved for the machine-clean report. Rendering
 * is a CLI concern only — core never logs — so the api>cli>sdk seam stays
 * intact.
 *
 * Defaults are TTY-aware. An interactive run renders a **single status line
 * that rewrites in place** (`\r`) — one line tracking the current phase plus
 * its progress (analyzer i/total during the measure phase) so a long run
 * reads as live activity rather than a wall of text;
 * {@link ProgressReporter.finish} clears it before the report prints. A piped
 * run (CI) stays silent unless `--verbose`, which switches to a durable
 * line-per-event log (no in-place rewrite) that also surfaces per-analyzer
 * detail. `--quiet` always suppresses.
 */

import type { AuditEvent, AuditPhase } from "../audit/index.ts";

/** Inputs that decide whether and how progress is rendered. */
export interface ProgressReporterOptions {
	/** Suppress all progress lines (`--quiet`). */
	quiet?: boolean;
	/** Surface per-analyzer detail (`--verbose`). */
	verbose?: boolean;
	/** Whether the diagnostics stream is a TTY — gates the default (interactive) on. */
	isTTY?: boolean;
	/** Line sink (default: stderr). Injected in tests to capture output. */
	write?: (line: string) => void;
}

/**
 * The CLI's progress handle: an {@link AuditEvent} sink wired into
 * `runWorkspaceAudit` plus a {@link finish} the command calls once the run
 * resolves — it clears the in-place status line so the report prints on a
 * clean line. `finish` is a no-op for the verbose line-per-event log (nothing
 * to clear).
 */
export interface ProgressReporter {
	onProgress: (event: AuditEvent) => void;
	finish: () => void;
}

/** Human label for a pipeline phase. */
function phaseLabel(phase: AuditPhase): string {
	switch (phase) {
		case "configure":
			return "loading configuration";
		case "discover":
			return "discovering sources";
		case "parse":
			return "parsing";
		case "measure":
			return "measuring";
		case "safeguards":
			return "inspecting safeguards";
		case "score":
			return "scoring";
		case "assemble":
			return "assembling report";
	}
}

/** Render one audit event to a progress line (analyzer/detail lines are verbose-only). */
function render(event: AuditEvent, verbose: boolean, write: (line: string) => void): void {
	switch (event.type) {
		case "phase":
			write(`trellis: ${phaseLabel(event.phase)}…\n`);
			return;
		case "source-discovered":
			write(`trellis: discovered ${event.files} file(s) in ${event.packages} package(s)\n`);
			return;
		case "syntax-built":
			if (verbose)
				write(`trellis: parsed ${event.files} file(s) · ${event.functions} function(s)\n`);
			return;
		case "analyzer":
			if (verbose) write(`trellis:   [${event.index + 1}/${event.total}] ${event.id}\n`);
			return;
		case "measured":
			if (verbose)
				write(`trellis: measured ${event.metrics} metric(s) · ${event.findings} finding(s)\n`);
			return;
		case "safeguards-inspected":
			if (verbose) write(`trellis: inspected ${event.results} safeguard(s)\n`);
			return;
		case "scored":
			write(`trellis: sloppiness index ${event.index}/100\n`);
			return;
	}
}

/** Spinner frames cycled on each event to signal liveliness during long waits. */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
/** Clear from the cursor to the end of the line so a shorter status fully overwrites a longer one. */
const CLEAR_EOL = "\x1b[K";

/** Mutable status the single-line renderer derives its one line from. */
interface StatusState {
	frame: number;
	phase: AuditPhase;
	/** Analyzer pass position (0-based) once the measure phase begins. */
	analyzer?: { index: number; total: number };
}

/** Compose the human portion of the status line from the accumulated {@link StatusState}. */
function statusText(s: StatusState): string {
	if (s.phase === "measure" && s.analyzer !== undefined) {
		return `measuring (${s.analyzer.index + 1}/${s.analyzer.total})`;
	}
	return phaseLabel(s.phase);
}

/** Fold one event into {@link StatusState}, advancing the spinner each call. */
function advance(s: StatusState, event: AuditEvent): void {
	s.frame += 1;
	switch (event.type) {
		case "phase":
			s.phase = event.phase;
			return;
		case "analyzer":
			s.analyzer = { index: event.index, total: event.total };
			return;
		default:
			return;
	}
}

/**
 * Build the interactive single-line reporter: every event rewrites one stderr
 * line in place (`\r`), so the run shows live activity without scrolling.
 */
function singleLineReporter(write: (line: string) => void): ProgressReporter {
	const s: StatusState = { frame: 0, phase: "configure" };
	let dirty = false;
	return {
		onProgress(event) {
			advance(s, event);
			dirty = true;
			const spin = SPINNER[s.frame % SPINNER.length];
			write(`\rtrellis: ${spin} ${statusText(s)}…${CLEAR_EOL}`);
		},
		finish() {
			if (dirty) write(`\r${CLEAR_EOL}`);
		},
	};
}

/**
 * Build the CLI progress handle, or `undefined` when progress should stay silent
 * (`--quiet`, or a non-TTY run without `--verbose`). Returning `undefined` lets
 * the caller omit `onProgress` entirely so a silent run allocates no renderer.
 *
 * A non-verbose TTY gets the in-place {@link singleLineReporter}; `--verbose`
 * gets the durable line-per-event log (with a no-op `finish`, since there is no
 * status line to clear) on any stream.
 */
export function createProgressReporter(
	opts: ProgressReporterOptions,
): ProgressReporter | undefined {
	if (opts.quiet) return undefined;
	if (!opts.verbose && !opts.isTTY) return undefined;
	const write = opts.write ?? ((line: string) => void process.stderr.write(line));
	if (opts.verbose) {
		return { onProgress: (event) => render(event, true, write), finish: () => {} };
	}
	return singleLineReporter(write);
}
