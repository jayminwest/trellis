/**
 * Shared CLI output + error scaffolding (SPEC §12, §13.1).
 *
 * Every command resolves an {@link OutputFormat} from the global `--json` /
 * `--md` flags, then hands three pre-rendered variants to {@link emit}, which
 * writes the right one to stdout. Failures route through {@link CliError} so the
 * top-level handler in `main.ts` renders them consistently (respecting the
 * caller's format) and exits with a stable code. Commands hold no other I/O
 * logic — they parse args, call core, and shape these three strings.
 */

/** Human-readable terminal text (default), machine JSON, or a markdown report. */
export type OutputFormat = "human" | "json" | "md";

/**
 * Stable process exit codes (SPEC §12). `0` clean, `1` an operational/usage
 * error (the command could not run), `2` a tripped `--fail-on` policy (the
 * command ran and emitted its report, but the audit failed the gate). CI scripts
 * can tell "trellis broke" (`1`) from "the repo failed the bar" (`2`).
 */
export const EXIT = {
	/** Clean run. */
	OK: 0,
	/** A handled failure: bad usage, invalid data, or a surfaced core error. */
	ERROR: 1,
	/** A `--fail-on` policy tripped — the report was emitted, but it failed the bar. */
	FAIL: 2,
} as const;

/** A handled CLI failure carrying the exit code to use and an optional id/file. */
export class CliError extends Error {
	override readonly name = "CliError";
	readonly code: number;
	readonly detail: { id?: string; file?: string };

	constructor(
		message: string,
		code: number = EXIT.ERROR,
		detail: { id?: string; file?: string } = {},
	) {
		super(message);
		this.code = code;
		this.detail = detail;
	}
}

/**
 * Signals a clean run whose `--fail-on` policy tripped (SPEC §12). Thrown by a
 * command *after* it has already emitted its report to stdout, so the top-level
 * handler must not re-render it — it only writes the reasons to stderr and exits
 * with {@link code}. Distinct from {@link CliError} (which means the command
 * could not run and never produced output).
 */
export class FailOnExit extends Error {
	override readonly name = "FailOnExit";
	readonly code: number;
	readonly reasons: readonly string[];

	constructor(reasons: readonly string[], code: number = EXIT.FAIL) {
		super(reasons.join("; "));
		this.code = code;
		this.reasons = reasons;
	}
}

/** Resolve the output format from the (possibly global) `--json` / `--md` flags. */
export function resolveFormat(opts: { json?: boolean; md?: boolean }): OutputFormat {
	if (opts.json && opts.md) {
		throw new CliError("choose at most one of --json or --md", EXIT.ERROR);
	}
	if (opts.json) return "json";
	if (opts.md) return "md";
	return "human";
}

/** The three rendered variants of a command's result; `emit` picks one by format. */
export interface Rendered {
	human: string;
	json: unknown;
	md: string;
}

/** Write the variant matching `format` to stdout, with a single trailing newline. */
export function emit(format: OutputFormat, rendered: Rendered): void {
	const text =
		format === "json"
			? JSON.stringify(rendered.json, null, 2)
			: format === "md"
				? rendered.md
				: rendered.human;
	process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

/**
 * Render a {@link CliError} to stderr in the caller's format and return its exit
 * code. JSON callers get `{ "error": { message, id?, file? } }`; everyone else
 * gets a `trellis: <message>` line.
 */
export function renderError(error: CliError, format: OutputFormat): number {
	if (format === "json") {
		const payload = { error: { message: error.message, ...error.detail } };
		process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
	} else {
		process.stderr.write(`trellis: ${error.message}\n`);
	}
	return error.code;
}
