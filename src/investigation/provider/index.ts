/**
 * Investigation provider entrypoint (SPEC §9.0) — the single core surface
 * through which facts are produced.
 *
 * Per §13.1 the provider is a domain-core module: both the CLI (`trellis audit`)
 * and the typed SDK reach investigation through `investigate()`, so there is
 * exactly one implementation of the Pi transport and the two surfaces can never
 * disagree about how facts are produced. trellis has no HTTP server in MVP — the
 * "api" here is this programmatic core surface, not a network API.
 *
 * `investigate(repoPath, area, opts)` assembles the per-area Pi argv + env and
 * drives one bounded RPC session. It resolves to {@link InvestigationResult}:
 * either validated facts (zod-checked against the area schema) or an honest
 * `no-detector`-shaped failure with a rationale — **never a fabricated pass**.
 * Downstream (`trellis-4222`) feeds the facts to the deterministic grader and
 * caches them; a failure degrades that area's criteria to `no-detector`.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Area, type AreaId, areaById } from "../areas.ts";
import { type AreaFindings, FINDINGS_SCHEMAS } from "../findings.ts";
import { buildPiArgv, type ProviderModelSource, resolveProviderModel } from "./pi/argv.ts";
import { buildPiEnv } from "./pi/env.ts";
import {
	DEFAULT_HEARTBEAT_MS,
	DEFAULT_MAX_RETRIES,
	type PiSpawn,
	runPiSession,
} from "./pi/session.ts";

export * from "./pi/index.ts";

/** Absolute path to the findings extension Pi loads via `-e` (SPEC §9.1). */
export const FINDINGS_EXTENSION_PATH = fileURLToPath(
	new URL("./pi/findings-extension.ts", import.meta.url),
);

/** The outcome of investigating one area: validated facts, or an honest failure. */
export type InvestigationResult<A extends AreaId = AreaId> =
	| { readonly ok: true; readonly area: A; readonly findings: AreaFindings[A] }
	| { readonly ok: false; readonly area: A; readonly reason: string };

/** Options for {@link investigate} (SPEC §9.3, §9.4). */
export interface InvestigateOpts {
	/** `--provider` CLI flag override (highest precedence). */
	readonly provider?: string;
	/** `--model` CLI flag override (highest precedence). */
	readonly model?: string;
	/** `targets.yaml` `defaults.investigation` provider/model (middle precedence). */
	readonly targetDefaults?: ProviderModelSource;
	/** Corrective re-prompt budget after the first attempt (default 2). */
	readonly maxRetries?: number;
	/** Heartbeat watchdog window in ms (default 120 000). */
	readonly heartbeatMs?: number;
	/** Source env for key passthrough (default `process.env`). */
	readonly sourceEnv?: NodeJS.ProcessEnv;
	/** Override the `pi` binary name/path (default `"pi"`). */
	readonly piBin?: string;
	/** Process-boundary injection for tests (default spawns the real `pi`). */
	readonly spawn?: PiSpawn;
	/** Override the findings-extension path (tests/packaging; default {@link FINDINGS_EXTENSION_PATH}). */
	readonly extensionPath?: string;
}

/** The kickoff user prompt that starts a run (the area system prompt is on argv). */
function kickoffMessage(area: Area): string {
	return (
		`Begin the "${area.title}" investigation now. ${area.description} ` +
		"Gather the facts with read-only tools, then call submit_findings exactly once."
	);
}

/**
 * Investigate one area of a repo via a bounded Pi RPC run (SPEC §9.0). Returns
 * validated facts on success, or `{ ok: false, reason }` on any failure
 * (no/invalid submission after retries, timeout, error, or process death) —
 * the caller maps that to `no-detector`.
 */
export async function investigate<A extends AreaId>(
	repoPath: string,
	areaId: A,
	opts: InvestigateOpts = {},
): Promise<InvestigationResult<A>> {
	const area = areaById(areaId);
	const providerModel = resolveProviderModel(
		{ provider: opts.provider, model: opts.model },
		opts.targetDefaults,
	);
	const argv = buildPiArgv({
		providerModel,
		extensionPath: opts.extensionPath ?? FINDINGS_EXTENSION_PATH,
		systemPrompt: area.prompt,
		piBin: opts.piBin,
	});
	const env = buildPiEnv({
		provider: providerModel.provider,
		area: areaId,
		sourceEnv: opts.sourceEnv,
	});
	const outcome = await runPiSession({
		argv,
		env,
		cwd: resolve(repoPath),
		promptMessage: kickoffMessage(area),
		schema: FINDINGS_SCHEMAS[areaId],
		maxRetries: Math.max(0, Math.trunc(opts.maxRetries ?? DEFAULT_MAX_RETRIES)),
		heartbeatMs: opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
		spawn: opts.spawn,
	});
	if (outcome.ok) {
		return { ok: true, area: areaId, findings: outcome.findings as AreaFindings[A] };
	}
	return { ok: false, area: areaId, reason: outcome.reason };
}
