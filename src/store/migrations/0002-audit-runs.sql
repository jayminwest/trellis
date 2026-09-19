-- Audit history. Applied once via PRAGMA user_version.

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
