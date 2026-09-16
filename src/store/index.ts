/**
 * Store layer (SPEC §6.4, §11) — the central `bun:sqlite` run history. Public
 * surface: {@link openStore} (migrate-on-open), the {@link Store} of typed
 * query/insert functions, the {@link StoredRun} row shape, and
 * {@link resolveDbPath} for the central-by-default DB location.
 */
export { MigrationError, migrate } from "./migrate.ts";
export {
	openStore,
	resolveDbPath,
	type Store,
	type StoredRun,
	storedReport,
	type TrendRow,
} from "./store.ts";
