/**
 * Public library entry for @os-eco/trellis-cli.
 *
 * Kept thin: only the version constant ships here, held in lockstep with
 * package.json (the release workflow asserts the two match — SPEC §13). The
 * typed SDK over the domain core lands under `src/client/` (SPEC §13.1).
 */

export const VERSION = "0.3.0";
