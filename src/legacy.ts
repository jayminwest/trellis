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

/**
 * Option-bag keys retired with the readiness product itself (SPEC §14,
 * trellis-9a88): the rubric, maturity levels, the gate/drift `--fail-on`
 * policy, the persist-by-default history, and canonical drift folded into the
 * audit all left with the deterministic pivot.
 */
const RETIRED_AUDIT_SURFACE_KEYS = [
	"rubric",
	"rubricVersion",
	"rubricDir",
	"canonical",
	"minLevel",
	"failOn",
	"persist",
	"repoId",
] as const;

/** The actionable rejection message for one retired readiness-audit knob. */
export function retiredAuditSurfaceMessage(name: string): string {
	return (
		`${name} no longer exists: the deterministic pivot (SPEC §14) replaced the ` +
		"readiness audit — there is no rubric, level, gate/drift policy, or " +
		"persist-by-default history to configure. Failure policies are declarative " +
		"in trellis.yaml (SPEC §6.5), persistence is the explicit `history` option " +
		`(SPEC §10), and canonical drift is the separate \`trellis drift\` capability. ` +
		`Remove ${name} and re-run.`
	);
}

/**
 * Reject retired readiness-audit keys on the deterministic audit's options bag
 * (SDK callers of {@link import("./audit/run.ts").runWorkspaceAudit}). Includes
 * the investigation keys ({@link rejectLegacyOptions}); throws
 * {@link LegacyConfigError} naming the first retired key found.
 */
export function rejectRetiredAuditOptions(opts: object): void {
	rejectLegacyOptions(opts);
	for (const key of RETIRED_AUDIT_SURFACE_KEYS) {
		if (key in opts) throw new LegacyConfigError(retiredAuditSurfaceMessage(`option '${key}'`));
	}
}
