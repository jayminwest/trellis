/**
 * Pi RPC argv construction (SPEC §9.1) — mirrors burrow's `buildPiArgv`, but
 * specialised for trellis's one-shot, read-only, structured-fact extraction.
 *
 * The argv is the read-only mandate made concrete: an allowlist of Pi's
 * read/search/list builtins plus the single `submit_findings` tool, the
 * trellis findings extension loaded explicitly under `--no-extensions`, and a
 * per-area system prompt. No mutating builtin (`bash`/`edit`/`write`) ever
 * reaches the allowlist, so an audit can never alter the repo it scores.
 *
 * Provider/model are always pinned explicitly (Pi's CLI default provider is
 * `google`); values come from {@link resolveProviderModel} (§9.4 precedence).
 * No API key is ever placed on argv — keys reach Pi via the environment only
 * (see `./env.ts`).
 */

/** The findings tool the per-area run must call exactly once (SPEC §9.2). */
export const SUBMIT_FINDINGS_TOOL = "submit_findings";

/**
 * Pi's read-only builtin tools (the `createReadOnlyTools` set, pinned against
 * the supported Pi version): read, search, list. Mutating builtins
 * (`bash`/`edit`/`write`) are deliberately excluded — this is the allowlist
 * that enforces §9.1's read-only mandate.
 */
export const READ_ONLY_BUILTINS: readonly string[] = ["read", "grep", "find", "ls"] as const;

/**
 * The full `--tools` allowlist: the read-only builtins plus `submit_findings`.
 * This exact list is what Pi is permitted to call; everything else is denied.
 */
export const PI_TOOL_ALLOWLIST: readonly string[] = [
	...READ_ONLY_BUILTINS,
	SUBMIT_FINDINGS_TOOL,
] as const;

/**
 * Built-in default provider/model when neither CLI flags nor `targets.yaml`
 * supply one (SPEC §9.4, the documented fallback constant). Anthropic + Haiku
 * mirrors burrow's pinned investigation runtime; both are fully overridable.
 */
export const DEFAULT_PROVIDER = "anthropic";
export const DEFAULT_MODEL = "claude-haiku-4-5";

/** Resolved provider/model pair (lowercased provider). */
export interface ProviderModel {
	readonly provider: string;
	readonly model: string;
}

/** A provider/model source layer (CLI flags or `targets.yaml` defaults). */
export interface ProviderModelSource {
	readonly provider?: string;
	readonly model?: string;
}

function nonEmpty(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve provider/model by SPEC §9.4 precedence:
 * CLI flags > `targets.yaml` `defaults.investigation` > built-in constant.
 * Provider names are lowercased (case-insensitive lookup, like burrow/warren);
 * the model is passed through verbatim (Pi matches model patterns itself).
 */
export function resolveProviderModel(
	flags?: ProviderModelSource,
	targetDefaults?: ProviderModelSource,
): ProviderModel {
	const provider =
		nonEmpty(flags?.provider) ?? nonEmpty(targetDefaults?.provider) ?? DEFAULT_PROVIDER;
	const model = nonEmpty(flags?.model) ?? nonEmpty(targetDefaults?.model) ?? DEFAULT_MODEL;
	return { provider: provider.toLowerCase(), model };
}

/** Inputs to {@link buildPiArgv}. */
export interface BuildPiArgvOptions {
	/** Resolved provider/model (see {@link resolveProviderModel}). */
	readonly providerModel: ProviderModel;
	/** Absolute path to the trellis findings extension module. */
	readonly extensionPath: string;
	/** The per-area system prompt (SPEC §9.2). */
	readonly systemPrompt: string;
	/** Override the `pi` binary name/path (default `"pi"`). */
	readonly piBin?: string;
}

/**
 * Render the Pi RPC argv (SPEC §9.1). The flag set is locked: `--mode rpc`,
 * `--no-session`, `--no-extensions -e <findings-extension>`, `--offline`,
 * `--no-context-files`, `--provider/--model`, `--tools <allowlist>`, and
 * `--system-prompt <per-area prompt>`. cwd (the target repo) is the caller's
 * responsibility — argv carries no path to it.
 */
export function buildPiArgv(opts: BuildPiArgvOptions): string[] {
	const bin = nonEmpty(opts.piBin) ?? "pi";
	return [
		bin,
		"--mode",
		"rpc",
		"--no-session",
		"--no-extensions",
		"-e",
		opts.extensionPath,
		"--offline",
		"--no-context-files",
		"--provider",
		opts.providerModel.provider,
		"--model",
		opts.providerModel.model,
		"--tools",
		PI_TOOL_ALLOWLIST.join(","),
		"--system-prompt",
		opts.systemPrompt,
	];
}
