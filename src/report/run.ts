/**
 * Audit service (SPEC §13.1) — the store-lifecycle-wrapped audit entrypoint the
 * CLI and SDK both fold. {@link auditRepo} is the pure pipeline; {@link runAudit}
 * adds the surrounding wiring that was previously inline in the CLI: open the
 * central store (unless `persist` is false), read the repo's prior run so the §11
 * delta reflects it, run the audit, persist the new run, and close the store.
 *
 * Keeping this in core (not the CLI) is what lets a programmatic audit and a CLI
 * audit exercise one code path — the SDK's `audit()` is a direct call to this.
 */
import { basename, resolve } from "node:path";
import type { Rubric } from "../rubric/index.ts";
import { openStore, storedReport } from "../store/index.ts";
import { type AuditOptions, auditRepo } from "./build.ts";
import type { AuditProgress } from "./progress.ts";
import type { Report } from "./types.ts";

/** Options for {@link runAudit} — the user-facing audit surface (mirrors the CLI flags). */
export interface AuditRunOptions {
	/** Informational rubric-version pin echoed onto the report (SPEC §12). */
	rubricVersion?: string;
	/** Canonical set version to compare against; present → fold `report.drift` (SPEC §10). */
	canonical?: string;
	/** Force re-investigation, ignoring cached findings (`--no-cache`, SPEC §7.3). */
	noCache?: boolean;
	/** SQLite history path; defaults to `$TRELLIS_DB` or `~/.trellis/trellis.db`. */
	db?: string;
	/** Persist this run to the central history; `false` touches no DB at all. Default true. */
	persist?: boolean;
	/** `pi` binary override passed through to the investigation provider. */
	piBin?: string;
	/** Wall-clock for `scoredAt` (determinism hook); defaults to now. */
	now?: Date;
	/** Preloaded rubric — pass to avoid a second load when the caller already has one. */
	rubric?: Rubric;
	/** Alternate rubric directory (test hook); ignored when `rubric` is given. */
	rubricDir?: string;
	/** Repo id for the report + central state; defaults to the audited path's basename. */
	repoId?: string;
	/**
	 * Optional progress sink (SPEC §7.3 observability). Mirrored by the SDK's
	 * {@link import("../client/index.ts").AuditRequest}; the CLI renders these
	 * events to stderr. Absent → a silent run.
	 */
	onProgress?: AuditProgress;
}

/**
 * Run an audit of the repo at `repoPath`, persisting it to the central history
 * (unless `persist` is false) and returning its §6.3 {@link Report}. The prior
 * run is read before the new one is inserted, so the embedded §11 delta reflects
 * it. The store doubles as the investigation cache (SPEC §7.3); with
 * `persist: false` the run is uncached and writes nothing.
 */
export async function runAudit(repoPath: string, opts: AuditRunOptions = {}): Promise<Report> {
	const store = opts.persist === false ? null : openStore(opts.db);
	try {
		const repoId = opts.repoId ?? basename(resolve(repoPath));
		const previous = store?.latestRun(repoId) ?? null;
		const auditOptions: AuditOptions = {
			...(opts.rubric ? { rubric: opts.rubric } : {}),
			...(opts.rubricDir ? { rubricDir: opts.rubricDir } : {}),
			...(opts.rubricVersion ? { rubricVersion: opts.rubricVersion } : {}),
			...(opts.now ? { now: opts.now } : {}),
			...(opts.repoId ? { repoId: opts.repoId } : {}),
			...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
			previousRun: previous ? storedReport(previous) : null,
			investigation: {
				...(store ? { cache: store } : {}),
				noCache: opts.noCache === true,
				...(opts.piBin ? { investigateOpts: { piBin: opts.piBin } } : {}),
			},
			...(opts.canonical ? { canonical: { canonicalVersion: opts.canonical } } : {}),
		};
		const report = await auditRepo(repoPath, auditOptions);
		store?.insertRun(report);
		return report;
	} finally {
		store?.close();
	}
}
