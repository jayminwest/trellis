/**
 * CLI progress rendering (SPEC §7.3 observability) — the surface half of the
 * core's progress contract. The domain core ({@link auditRepo}) emits structured
 * {@link AuditEvent}s; this module turns them into concise human lines on
 * **stderr**, keeping stdout reserved for the machine-clean report. Rendering is
 * a CLI concern only — core never logs — so the api>cli>sdk seam stays intact.
 *
 * Defaults are TTY-aware: an interactive run shows phase-level progress, a piped
 * run (CI) stays silent unless `--verbose` is given; `--quiet` always suppresses.
 * `--verbose` additionally surfaces per-criterion detector lines and per-message
 * Pi session events.
 */

import type { InvestigationEvent, SessionEvent } from "../investigation/index.ts";
import type { AuditEvent, AuditPhase } from "../report/index.ts";

/** Inputs that decide whether and how progress is rendered. */
export interface ProgressReporterOptions {
	/** Suppress all progress lines (`--quiet`). */
	quiet?: boolean;
	/** Surface per-detector / per-session-message detail (`--verbose`). */
	verbose?: boolean;
	/** Whether the diagnostics stream is a TTY — gates the default (interactive) on. */
	isTTY?: boolean;
	/** Line sink (default: stderr). Injected in tests to capture output. */
	write?: (line: string) => void;
}

/** Human label for a pipeline phase. */
function phaseLabel(phase: AuditPhase): string {
	switch (phase) {
		case "discovery":
			return "discovering apps";
		case "investigation":
			return "running investigation";
		case "detectors":
			return "running detectors";
		case "scoring":
			return "scoring";
	}
}

/** Human label for a Pi session event (verbose-only detail). */
function sessionLabel(event: SessionEvent): string {
	switch (event.type) {
		case "message":
			return "agent message";
		case "agent-end":
			return "turn ended";
		case "retry":
			return `corrective retry ${event.attempt}`;
		case "heartbeat-stall":
			return "stalled (no output)";
	}
}

/** Render one lifted investigation event; session events only in verbose mode. */
function renderInvestigation(
	event: InvestigationEvent,
	verbose: boolean,
	write: (line: string) => void,
): void {
	switch (event.type) {
		case "area-start":
			write(`trellis:   ${event.area} (${event.index + 1}/${event.total})\n`);
			return;
		case "cache-hit":
			write(`trellis:   ${event.area}: cache hit\n`);
			return;
		case "probe":
			write(
				event.ok
					? `trellis:   pi ${event.detail} ready\n`
					: `trellis:   pi unavailable: ${event.detail}\n`,
			);
			return;
		case "session":
			if (verbose) write(`trellis:   ${event.area}: ${sessionLabel(event.event)}\n`);
			return;
		case "area-end":
			write(
				event.ok
					? `trellis:   ${event.area}: done\n`
					: `trellis:   ${event.area}: ${event.reason ?? "unavailable"}\n`,
			);
			return;
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
		case "investigation":
			renderInvestigation(event.event, verbose, write);
			return;
	}
}

/**
 * Build the {@link AuditEvent} sink the CLI passes into `runAudit`, or
 * `undefined` when progress should stay silent (`--quiet`, or a non-TTY run
 * without `--verbose`). Returning `undefined` lets the caller omit `onProgress`
 * entirely, so a silent run never allocates a renderer.
 */
export function createProgressReporter(
	opts: ProgressReporterOptions,
): ((event: AuditEvent) => void) | undefined {
	if (opts.quiet) return undefined;
	if (!opts.verbose && !opts.isTTY) return undefined;
	const verbose = opts.verbose === true;
	const write = opts.write ?? ((line: string) => void process.stderr.write(line));
	return (event: AuditEvent) => render(event, verbose, write);
}
