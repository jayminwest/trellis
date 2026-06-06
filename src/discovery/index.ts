/**
 * App discovery (SPEC §8.2) — find independently-deployable directories as apps
 * before app-scope scoring. Public surface: the {@link discoverApps} entrypoint,
 * the §6.3 {@link toAppMap} projection, and the {@link App} contract.
 */
export { DEFAULT_MAX_DEPTH, discoverApps, toAppMap } from "./discover.ts";
export type { App, DiscoverOptions, Language } from "./types.ts";
