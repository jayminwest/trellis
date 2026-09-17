/**
 * Legacy investigation configuration (SPEC §14 stages 2–3) — the agent
 * investigation pass is disconnected from every public audit path and the
 * subsystem itself is deleted, so the provider/model, `piBin`, and
 * investigation-cache knobs no longer exist. Passing one is a configuration
 * error, never a silent no-op: every public entry point (CLI flags/env, SDK
 * option bags, `targets.yaml` defaults) rejects it with an actionable message
 * naming what to remove.
 */

/** A caller passed retired investigation configuration. */
export class LegacyConfigError extends Error {
	override readonly name = "LegacyConfigError";
}

/** Option-bag keys retired with the agent investigation pass (SPEC §14 stage 2). */
const RETIRED_OPTION_KEYS = ["noCache", "piBin", "investigation", "provider", "model"] as const;

/** The actionable rejection message for one retired configuration knob. */
export function legacyConfigMessage(name: string): string {
	return (
		`${name} no longer exists: trellis disconnected the agent investigation pass ` +
		"(SPEC §14) — audits are deterministic and offline, with no provider, model, " +
		`or findings cache to configure. Remove ${name} and re-run.`
	);
}

/**
 * The actionable rejection message for one retired readiness-product knob
 * (SPEC §14 stage 9): the rubric, maturity levels, `--fail-on` modes, and
 * persist-by-default history went away with the deterministic pivot. Failure
 * policies are now declarative in `trellis.yaml` (SPEC §6.5, §9) and history
 * is opt-in (SPEC §10).
 */
export function retiredReadinessMessage(name: string): string {
	return (
		`${name} no longer exists: the readiness rubric, maturity levels, and their flags ` +
		"were removed in the deterministic pivot (SPEC §14) — the audit now emits the " +
		"sloppiness index and gates on the declarative policy in trellis.yaml (SPEC §6.5, §9). " +
		`Remove ${name} and re-run.`
	);
}

/**
 * Reject retired investigation keys on a public options bag (the core services
 * the CLI and SDK fold). TypeScript callers already get a compile error from
 * the narrowed option types; this guard gives untyped callers the same
 * actionable failure instead of a silent ignore. Throws
 * {@link LegacyConfigError} naming the first retired key found.
 */
export function rejectLegacyOptions(opts: object): void {
	for (const key of RETIRED_OPTION_KEYS) {
		if (key in opts) throw new LegacyConfigError(legacyConfigMessage(`option '${key}'`));
	}
}
