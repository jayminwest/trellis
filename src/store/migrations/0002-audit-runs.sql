-- Migration 0002 — deterministic sloppiness-audit history (SPEC §10, trellis-424d).
-- The pivoted product's run history: one `audit_runs` row per §6.4 audit report,
-- keyed by a collision-resistant repository identity and carrying the three §3.5
-- versions so trend queries can select only compatible runs. Append-only: the
-- legacy readiness tables (`runs`, `criterion_results`, `investigation_cache`)
-- are left untouched — legacy rows are preserved as legacy readiness history
-- and never migrated into the sloppiness scale (SPEC §10).
-- Applied exactly once; the runner gates on PRAGMA user_version.

-- one row per deterministic audit (SPEC §6.4 report)
CREATE TABLE audit_runs (
  id               INTEGER PRIMARY KEY,
  repo_root        TEXT NOT NULL,      -- absolute workspace root from the report
  repo_identity    TEXT NOT NULL,      -- repoIdentity(): label#hash(canonical root)
  schema_version   TEXT NOT NULL,      -- §3.5 contract version
  analyzer_version TEXT NOT NULL,      -- §3.5 trellis release
  scoring_version  TEXT NOT NULL,      -- §3.5 formula version
  sloppiness_index REAL NOT NULL,      -- 0–100, lower is better
  partial          INTEGER NOT NULL,   -- 0/1 (SQLite has no BOOLEAN)
  completeness     TEXT NOT NULL,      -- complete | incomplete
  report_json      TEXT NOT NULL,      -- full §6.4 report (renderAuditJson bytes)
  audited_at       TEXT NOT NULL
);
CREATE INDEX audit_runs_identity_time ON audit_runs (repo_identity, audited_at);
