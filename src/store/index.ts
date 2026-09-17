/**
 * Store layer (SPEC §6.4, §10, §11) — the central `bun:sqlite` run history.
 * Public surface: {@link openStore} (migrate-on-open), the {@link Store} of
 * typed query/insert functions (legacy readiness plus the composed
 * {@link AuditStore} sloppiness operations), the {@link StoredRun} /
 * {@link StoredAuditRun} row shapes, {@link repoIdentity} for
 * collision-resistant repository identity, {@link resolveDbPath} for the
 * central-by-default DB location, and the scored-basis selection helpers
 * ({@link decodedStoredReport} / {@link scoredBasisCompatible}) history
 * surfaces reuse.
 */
export {
	type AuditStore,
	repoIdentity,
	type SloppinessTrendPoint,
	type StoredAuditRun,
	storedAuditReport,
} from "./audit-store.ts";
export { decodedStoredReport, scoredBasisCompatible } from "./compatible-runs.ts";
export { MigrationError, migrate } from "./migrate.ts";
export {
	openStore,
	resolveDbPath,
	type Store,
	type StoredRun,
	storedReport,
	type TrendRow,
} from "./store.ts";
