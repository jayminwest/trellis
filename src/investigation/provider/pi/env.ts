/**
 * Pi subprocess environment (SPEC §9.4) — env passthrough only, never argv.
 *
 * API keys reach the Pi subprocess exclusively through its environment; argv
 * carries only `--provider`/`--model` (see `./argv.ts`). This module computes
 * the *exact* set of host env vars forwarded to a Pi run: the anthropic base
 * triple always, plus the provider-conditional keys from
 * {@link PI_PROVIDER_ENV_KEYS} when a non-anthropic provider is selected.
 *
 * Mirrors burrow's `piEnvPassthrough` conventions (provider names matched
 * case-insensitively; Gemini reached via provider `"google"` reading
 * `GEMINI_API_KEY`). Only names actually set on the host are forwarded, so an
 * unset key contributes nothing.
 */

import { AREA_ENV_VAR } from "./findings-extension.ts";

/**
 * Anthropic base env keys forwarded to every Pi run regardless of provider, so
 * the default (no-override) path always authenticates against Anthropic.
 */
export const PI_BASE_ENV_KEYS: readonly string[] = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
] as const;

/**
 * Per-provider env keys forwarded *in addition to* the anthropic base when a
 * non-anthropic provider is selected (SPEC §9.4). Provider names match Pi's
 * `--provider <name>` vocabulary exactly; each value is the env var Pi consults
 * for that provider. Gemini is reached via provider `"google"` reading
 * `GEMINI_API_KEY` (Pi has no `"gemini"` provider name).
 */
export const PI_PROVIDER_ENV_KEYS: Readonly<Record<string, readonly string[]>> = {
	openai: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
	google: ["GEMINI_API_KEY"],
	groq: ["GROQ_API_KEY"],
	mistral: ["MISTRAL_API_KEY"],
	deepseek: ["DEEPSEEK_API_KEY"],
};

/**
 * The env-var names forwarded to a Pi run for `provider`. Always the anthropic
 * base; a non-anthropic provider appends its matching {@link PI_PROVIDER_ENV_KEYS}
 * entry. Unknown providers contribute nothing beyond the base. Provider is
 * lowercased before lookup (callers already lowercase via `resolveProviderModel`,
 * but this stays robust to direct callers).
 */
export function piEnvKeysFor(provider: string): readonly string[] {
	const normalized = provider.trim().toLowerCase();
	if (normalized === "anthropic" || normalized.length === 0) return PI_BASE_ENV_KEYS;
	const extra = PI_PROVIDER_ENV_KEYS[normalized];
	if (!extra || extra.length === 0) return PI_BASE_ENV_KEYS;
	return [...PI_BASE_ENV_KEYS, ...extra];
}

/** Inputs to {@link buildPiEnv}. */
export interface BuildPiEnvOptions {
	/** The (lowercased) provider name selected for the run. */
	readonly provider: string;
	/** The investigation area id, passed to the extension via {@link AREA_ENV_VAR}. */
	readonly area: string;
	/** Source environment to read passthrough keys from (default `process.env`). */
	readonly sourceEnv?: NodeJS.ProcessEnv;
}

/**
 * Build the environment for a Pi subprocess (SPEC §9.4). Returns a fresh object
 * containing: every passthrough key from {@link piEnvKeysFor} that is set on
 * `sourceEnv`, plus `PATH` (so the `pi` binary and its toolchain resolve), plus
 * {@link AREA_ENV_VAR} telling the findings extension which area's schema to
 * register. No secret is ever read from or written to argv.
 */
export function buildPiEnv(opts: BuildPiEnvOptions): Record<string, string> {
	const source = opts.sourceEnv ?? process.env;
	const env: Record<string, string> = {};
	// PATH is not a secret and is required to locate `pi` + its node runtime.
	if (typeof source.PATH === "string") env.PATH = source.PATH;
	for (const key of piEnvKeysFor(opts.provider)) {
		const value = source[key];
		if (typeof value === "string" && value.length > 0) env[key] = value;
	}
	env[AREA_ENV_VAR] = opts.area;
	return env;
}
