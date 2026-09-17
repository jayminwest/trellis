/**
 * Discovery (SPEC §3.1, transitional §8.2).
 *
 * - TS/TSX source discovery → classified workspace inventory:
 *   {@link discoverSourceInventory} + {@link toSourceCoverage} over the
 *   {@link SourceInventory} contract, with classification in `classify.ts`
 *   and the documented glob subset in `glob.ts`.
 * - Legacy app discovery (transitional rubric support): {@link discoverApps}
 *   and the §6.3 {@link toAppMap} projection over the {@link App} contract.
 */
export {
	type Classification,
	classifyTsFile,
	isTypeScriptSource,
	isUnsupportedSource,
	UNSUPPORTED_SOURCE_EXTENSIONS,
} from "./classify.ts";
export { DEFAULT_MAX_DEPTH, discoverApps, toAppMap } from "./discover.ts";
export { matchAnyGlob, matchGlob } from "./glob.ts";
export {
	type ClassifiedFile,
	type DiscoverInventoryOptions,
	discoverSourceInventory,
	type ExcludedFile,
	type IgnoredEntry,
	type IgnoredReason,
	type SourceInventory,
	toSourceCoverage,
	type WorkspacePackage,
} from "./inventory.ts";
export type { App, DiscoverOptions, Language } from "./types.ts";
