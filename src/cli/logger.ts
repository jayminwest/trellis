/**
 * CLI logger (pino). Diagnostics go to **stderr** (fd 2) so that `--json` /
 * `--md` payloads on stdout stay machine-clean. The level is read once from
 * `TRELLIS_LOG_LEVEL` (default `warn`), keeping ordinary runs quiet while
 * leaving `debug`/`trace` a single env flip away.
 */
import pino, { type Logger } from "pino";

/** Resolve the log level from the environment, defaulting to `warn`. */
function resolveLevel(): string {
	const level = process.env.TRELLIS_LOG_LEVEL?.trim();
	return level && level.length > 0 ? level : "warn";
}

/** Process-wide CLI logger, writing to stderr. */
export const logger: Logger = pino({ level: resolveLevel(), base: undefined }, pino.destination(2));
