/**
 * CLI progress rendering — the surface half of the core's progress contract.
 * The domain core ({@link auditRepo}) emits structured {@link AuditEvent}s;
 * this module turns them into human progress on **stderr**, keeping stdout
 * reserved for the machine-clean report. Rendering is a CLI concern only —
 * core never logs — so the api>cli>sdk seam stays intact.
 *
 * Defaults are TTY-aware. An interactive run renders a **single status line
 * that rewrites in place** (`\r`) — one line tracking the current phase plus
 * its progress (apps discovered, detector i/total) so a long run reads as live
 * activity rather than a wall of text; {@link ProgressReporter.finish} clears
 * it before the report prints. A piped run (CI) stays silent unless
 * `--verbose`, which switches to a durable line-per-event log (no in-place
 * rewrite) that also surfaces per-criterion detector lines. `--quiet` always
 * suppresses.
 */

import type { AuditEvent, AuditPhase } from "../report/index.ts";

/** Inputs that decide whether and how progress is rendered. */
export interface ProgressReporterOptions {
	/** Suppress all progress lines (`--quiet`). */
	quiet?: boolean;
	/** Surface per-detector detail (`--verbose`). */
	verbose?: boolean;
	/** Whether the diagnostics stream is a TTY — gates the default (interactive) on. */
	isTTY?: boolean;
	/** Line sink (default: stderr). Injected in tests to capture output. */
	write?: (line: string) => void;
}

/**
 * The CLI's progress handle: an {@link AuditEvent} sink wired into `runAudit`
 * plus a {@link finish} the command calls once the run resolves — it clears the
 * in-place status line so the report prints on a clean line. `finish` is a no-op
 * for the verbose line-per-event log (nothing to clear).
 */
export interface ProgressReporter {
	onProgress: (event: AuditEvent) => void;
	finish: () => void;
}

/** Human label for a pipeline phase. */
function phaseLabel(phase: AuditPhase): string {
	switch (phase) {
		case "discovery":
			return "discovering apps";
		case "detectors":
			return "running detectors";
		case "scoring":
			return "scoring";
	}
}

/** Render one audit event to a progress line (detector lines are verbose-only). */
function render(event: AuditEvent, verbose: boolean, write: (line: string) => void): void {
	switch (event.type) {
		case "phase":
			write(`trellis: ${phaseLabel(event.phase)}…\n`);
			return;
		case "apps-discovered":
			write(`trellis: discovered ${event.count} app(s)\n`);
			return;
		case "detector":
			if (verbose) write(`trellis:   [${event.index + 1}/${event.total}] ${event.id}\n`);
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
	/** Detector pass position (1-based) once detectors begin. */
	detector?: { index: number; total: number };
	/** Number of apps discovered, surfaced through the discovery phase. */
	apps?: number;
}

/** Compose the human portion of the status line from the accumulated {@link StatusState}. */
function statusText(s: StatusState): string {
	switch (s.phase) {
		case "discovery":
			return s.apps === undefined ? "discovering apps" : `discovered ${plural(s.apps, "app")}`;
		case "detectors":
			return s.detector
				? `running detectors (${s.detector.index + 1}/${s.detector.total})`
				: "running detectors";
		case "scoring":
			return "scoring";
	}
}

/** `"1 app"` / `"3 apps"` — count with a naively pluralized noun. */
function plural(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** Fold one event into {@link StatusState}, advancing the spinner each call. */
function advance(s: StatusState, event: AuditEvent): void {
	s.frame += 1;
	switch (event.type) {
		case "phase":
			s.phase = event.phase;
			return;
		case "detector":
			s.detector = { index: event.index, total: event.total };
			return;
		case "apps-discovered":
			s.apps = event.count;
			return;
	}
}

/**
 * Build the interactive single-line reporter: every event rewrites one stderr
 * line in place (`\r`), so the run shows live activity without scrolling.
 */
function singleLineReporter(write: (line: string) => void): ProgressReporter {
	const s: StatusState = { frame: 0, phase: "discovery" };
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
