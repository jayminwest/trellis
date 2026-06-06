/**
 * Store layer (SPEC §6.4, §11) — the central `bun:sqlite` run history. Public
 * surface: {@link openStore} (migrate-on-open), the {@link Store} of typed
 * query/insert functions, the {@link StoredRun} / {@link CachedFindings} row
 * shapes, and {@link resolveDbPath} for the central-by-default DB location.
 */
export { MigrationError, migrate } from "./migrate.ts";
export {
	type CachedFindings,
	openStore,
	resolveDbPath,
	type Store,
	type StoredRun,
} from "./store.ts";
