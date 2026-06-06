/**
 * Pi RPC transport (SPEC §9) — argv, env passthrough, the findings extension,
 * the version probe, and the session state machine. The provider entrypoint
 * (`../index.ts`) composes these into `investigate()`; nothing else in trellis
 * spawns Pi.
 */
export {
	type BuildPiArgvOptions,
	buildPiArgv,
	DEFAULT_MODEL,
	DEFAULT_PROVIDER,
	PI_TOOL_ALLOWLIST,
	type ProviderModel,
	type ProviderModelSource,
	READ_ONLY_BUILTINS,
	resolveProviderModel,
	SUBMIT_FINDINGS_TOOL,
} from "./argv.ts";
export {
	type BuildPiEnvOptions,
	buildPiEnv,
	PI_BASE_ENV_KEYS,
	PI_PROVIDER_ENV_KEYS,
	piEnvKeysFor,
} from "./env.ts";
export {
	AREA_ENV_VAR,
	type PiExtensionApi,
	type PiToolDefinition,
	resolveAreaFromEnv,
	submitFindingsTool,
} from "./findings-extension.ts";
export {
	DEFAULT_HEARTBEAT_MS,
	DEFAULT_MAX_RETRIES,
	defaultPiSpawn,
	formatZodIssues,
	type PiProcessHandle,
	type PiSessionConfig,
	type PiSpawn,
	promptCommand,
	runPiSession,
	type SessionOutcome,
} from "./session.ts";
export {
	MIN_SUPPORTED_PI_VERSION,
	PI_INSTALL_HINT,
	type PiVersionProbe,
	type ProbePiVersionOptions,
	parseSemver,
	probePiVersion,
	SUPPORTED_PI_VERSION,
	semverGte,
	type VersionSpawn,
} from "./version.ts";
