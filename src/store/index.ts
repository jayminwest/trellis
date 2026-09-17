/**
 * Store layer (SPEC §6.4, §10, §11) — the central `bun:sqlite` run history.
 * Public surface: {@link openStore} (migrate-on-open), the {@link Store} of
 * typed query/insert functions (legacy readiness plus the composed
 * {@link AuditStore} sloppiness operations), the {@link StoredRun} /
 * {@link StoredAuditRun} row shapes, {@link repoIdentity} for
 * collision-resistant repository identity, and {@link resolveDbPath} for the
 * central-by-default DB location.
 */
export {
	type AuditStore,
	type ReportVersions,
	repoIdentity,
	reportVersions,
	type SloppinessTrendPoint,
	type StoredAuditRun,
	storedAuditReport,
} from "./audit-store.ts";
export { MigrationError, migrate } from "./migrate.ts";
export {
	openStore,
	resolveDbPath,
	type Store,
	type StoredRun,
	storedReport,
	type TrendRow,
} from "./store.ts";
