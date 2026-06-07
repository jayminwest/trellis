/**
 * `--fail-on` / `--min-level` flag parsing (SPEC §12), shared by `audit` and
 * `fleet`. Maps the raw commander option strings onto a core {@link FailPolicy},
 * validating `--min-level` to a {@link Level}. The default (flag omitted) leaves
 * `mode` unset, which the core assessment reads as "fail on gate OR drift".
 */
import { FAIL_ON_MODES, type FailOnMode, type FailPolicy } from "../report/index.ts";
import type { Level } from "../rubric/index.ts";
import { CliError, EXIT } from "./output.ts";

/** Raw `--fail-on` / `--min-level` options as commander parses them. */
export interface FailOnCliOptions {
	failOn?: string;
	minLevel?: string;
}

/** Parse `--min-level` into a {@link Level} (1–5), or throw a {@link CliError}. */
function parseMinLevel(raw: string | undefined): Level | undefined {
	if (raw === undefined) return undefined;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 1 || n > 5) {
		throw new CliError(`--min-level must be an integer 1–5 (got "${raw}")`, EXIT.ERROR);
	}
	return n as Level;
}

/** Build a core {@link FailPolicy} from the raw CLI flags, validating both. */
export function failPolicy(opts: FailOnCliOptions): FailPolicy {
	const mode = opts.failOn as FailOnMode | undefined;
	if (mode !== undefined && !FAIL_ON_MODES.includes(mode)) {
		throw new CliError(
			`--fail-on must be one of ${FAIL_ON_MODES.join("|")} (got "${opts.failOn}")`,
			EXIT.ERROR,
		);
	}
	const minLevel = parseMinLevel(opts.minLevel);
	return { ...(mode ? { mode } : {}), ...(minLevel ? { minLevel } : {}) };
}
