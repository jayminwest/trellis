/**
 * `--provider` flag translation (SPEC §16.4, plan `pl-43c5` step 18 —
 * trellis-5ee9) — the CLI's minimal provider-selection surface.
 *
 * Pure data shaping plus fail-fast validation, nothing else: the repeatable
 * flag values translate into exactly the declarative `providers` block the
 * core configuration accepts (`providerSelectionSchema`,
 * `src/contract/config.ts`) — no CLI-side planning, execution or policy
 * evaluation. The supported-provider vocabulary is read from the core
 * capability table (`src/providers/capabilities.ts`) and the core selection
 * schema has the final word, so the flag surface and the core can never
 * drift apart. Bad selections are actionable operational errors (exit 1,
 * SPEC §16.3) raised before any measurement runs. The flag surface carries
 * no per-provider request data: jscpd selects its match mode and every other
 * provider's richer request lives in the providers block of trellis.yaml.
 */
import { CLONE_MATCH_MODES, type CloneMatchMode } from "../contract/clone-evidence.ts";
import { type ProviderSelection, providerSelectionSchema } from "../contract/config.ts";
import { SUPPORTED_PROVIDERS } from "../providers/capabilities.ts";
import { CliError } from "./output.ts";

/**
 * The requestable optional-provider ids (SPEC §16.1) — the literal type of
 * the core selection schema's keys (`providerSelectionSchema`), whose parse
 * in {@link providerSelectionFromFlags} is the drift belt keeping the two
 * vocabularies honest.
 */
type RequestableProviderId = "jscpd" | "dependency-cruiser" | "knip" | "sonarjs";

/**
 * The supported optional-provider ids (SPEC §16.1) — read from the core
 * capability table (`src/providers/capabilities.ts`), never re-declared
 * here, so the flag vocabulary and the table can never drift apart. Sorted
 * for stable, actionable error messages.
 */
const SUPPORTED_PROVIDER_IDS: readonly RequestableProviderId[] = SUPPORTED_PROVIDERS.map(
	(entry) => entry.providerId as RequestableProviderId,
).sort();

/** Whether `id` names a supported optional provider (the capability table). */
function isSupportedProviderId(id: string): id is RequestableProviderId {
	return (SUPPORTED_PROVIDER_IDS as readonly string[]).includes(id);
}

/** One parsed `--provider` selection: a provider id plus its request data. */
type ProviderFlagEntry =
	| { readonly id: "jscpd"; readonly mode: CloneMatchMode }
	| { readonly id: Exclude<RequestableProviderId, "jscpd"> };

/** Split one `--provider` value into its provider id and optional `:option` part. */
function splitProviderSelection(selection: string): { id: string; option?: string } {
	const separator = selection.indexOf(":");
	if (separator === -1) return { id: selection };
	return { id: selection.slice(0, separator), option: selection.slice(separator + 1) };
}

/** Whether `value` names one of the pinned jscpd match modes (`CLONE_MATCH_MODES`). */
function isMatchMode(value: string): value is CloneMatchMode {
	return (CLONE_MATCH_MODES as readonly string[]).includes(value);
}

/**
 * Parse one `--provider` value into its request data, rejecting unknown ids
 * (the closed vocabulary of the core capability table), a missing jscpd
 * match mode and flag options on providers whose requests are declarative —
 * actionable operational errors (exit 1, SPEC §16.3) raised before any
 * measurement runs.
 */
function parseProviderFlag(raw: string): ProviderFlagEntry {
	if (raw.length === 0) {
		throw new CliError(
			"--provider needs a provider id, optionally with an option: " +
				"--provider <id[:mode]> (e.g. --provider jscpd:normalized)",
		);
	}
	const { id, option } = splitProviderSelection(raw);
	if (!isSupportedProviderId(id)) {
		throw new CliError(
			`unknown provider "${id}" in --provider ${raw}: supported optional providers are ` +
				`${SUPPORTED_PROVIDER_IDS.join(", ")} — richer per-provider requests live in the ` +
				"providers block of trellis.yaml (SPEC §16.4)",
		);
	}
	if (id !== "jscpd") {
		// The non-jscpd request shapes are declarative data (architecture rules,
		// reachability entries and surfaces, the gated SonarJS capability): the
		// flag surface carries no options for them — richer per-provider
		// requests live in the providers block of trellis.yaml (SPEC §16.4).
		if (option !== undefined) {
			throw new CliError(
				`provider "${id}" takes no flag options — its request is declarative; pass ` +
					`--provider ${id} and declare richer requests in the providers block of ` +
					"trellis.yaml (SPEC §16.4)",
			);
		}
		return { id };
	}
	// The delivered duplication-evidence adapter: one explicit match mode per
	// request (the pinned thresholds are not audit-time knobs, §16.2).
	if (option === undefined) {
		throw new CliError(
			`provider "jscpd" needs a match mode: --provider jscpd:<${CLONE_MATCH_MODES.join("|")}>`,
		);
	}
	if (!isMatchMode(option)) {
		throw new CliError(
			`unknown jscpd match mode "${option}": supported modes are ${CLONE_MATCH_MODES.join(" | ")}`,
		);
	}
	return { id: "jscpd", mode: option };
}

/** Fold parsed flag entries into the declarative `providers` block (§16.4). */
function flagEntriesToSelection(entries: readonly ProviderFlagEntry[]): ProviderSelection {
	const selection: ProviderSelection = {};
	for (const entry of entries) {
		if (entry.id === "jscpd") selection.jscpd = { mode: entry.mode };
		else if (entry.id === "dependency-cruiser") selection["dependency-cruiser"] = {};
		else if (entry.id === "knip") selection.knip = {};
		else selection.sonarjs = {};
	}
	return selection;
}

/**
 * Translate repeatable `--provider` flag values into the same declarative
 * `providers` block the core configuration accepts (SPEC §16.4). Duplicate
 * providers and conflicting selections are actionable operational errors
 * (exit 1, SPEC §16.3) raised before any measurement runs; the core's own
 * selection schema has the final word so the two vocabularies can never drift.
 */
export function providerSelectionFromFlags(selections: readonly string[]): ProviderSelection {
	const seen = new Map<string, string>();
	const entries: ProviderFlagEntry[] = [];
	for (const raw of selections) {
		const entry = parseProviderFlag(raw);
		const previous = seen.get(entry.id);
		if (previous !== undefined) {
			throw new CliError(
				previous === raw
					? `provider "${entry.id}" is selected more than once — pass --provider once per provider`
					: `conflicting --provider selections for "${entry.id}": "${previous}" and "${raw}" — ` +
							"pass exactly one selection per provider",
			);
		}
		seen.set(entry.id, raw);
		entries.push(entry);
	}
	const validated = providerSelectionSchema.safeParse(flagEntriesToSelection(entries));
	if (!validated.success) {
		const details = validated.error.issues
			.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
			.join("; ");
		throw new CliError(`invalid --provider selection: ${details}`);
	}
	return validated.data;
}
